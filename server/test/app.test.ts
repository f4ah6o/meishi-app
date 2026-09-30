import type { CorporationCandidate } from "@meishi/shared";
import { describe, expect, it } from "vitest";
import { createApp, type Deps } from "../src/app.ts";
import { type AppConfig, loadConfig } from "../src/config.ts";
import type { CorporateRegistry } from "../src/corporate/registry.ts";
import { RuleDecisionProvider } from "../src/decision/decision.ts";
import { StubExtractor } from "../src/extract/stub.ts";
import { MemoryStore } from "../src/kintone/memory.ts";

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function makeConfig(over: Partial<AppConfig> = {}): AppConfig {
  return { ...loadConfig({ AUTH_MODE: "dev", CARD_EXTRACTOR: "stub" }), ...over };
}

class FakeRegistry implements CorporateRegistry {
  constructor(private candidates: CorporationCandidate[]) {}
  async search(): Promise<CorporationCandidate[]> {
    return this.candidates;
  }
}

function makeDeps(over: Partial<Deps> = {}): Deps {
  const config = makeConfig();
  return {
    config,
    extractor: new StubExtractor(),
    store: new MemoryStore(),
    registry: new FakeRegistry([]),
    decider: new RuleDecisionProvider(),
    ...over,
  };
}

describe("POST /api/cards/analyze", () => {
  it("extracts, normalizes, and identifies a card", async () => {
    const app = createApp(makeDeps());
    const res = await app.request("/api/cards/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_base64: PNG_1PX }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.extraction.company_name).toBe("株式会社山田建設");
    expect(body.extraction.company_name_key).toBe("山田建設");
    expect(body.extraction.domain).toBe("yamada-kensetsu.co.jp");
  });

  it("rejects non-image payloads with 415", async () => {
    const app = createApp(makeDeps());
    const res = await app.request("/api/cards/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_base64: Buffer.from("not an image").toString("base64") }),
    });
    expect(res.status).toBe(415);
  });

  it("rejects oversized payloads", async () => {
    const app = createApp(makeDeps({ config: makeConfig({ maxImageBytes: 10 }) }));
    const res = await app.request("/api/cards/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_base64: PNG_1PX }),
    });
    expect(res.status).toBe(413);
  });

  it("returns corporate candidates and a decision", async () => {
    const app = createApp(
      makeDeps({
        registry: new FakeRegistry([
          {
            source: "nta",
            corporate_number: "1234567890123",
            official_name: "株式会社山田建設",
            prefecture: "東京都",
            city: "千代田区",
            website: "https://yamada-kensetsu.co.jp",
          },
        ]),
      }),
    );
    const res = await app.request("/api/cards/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_base64: PNG_1PX }),
    });
    const body = (await res.json()) as any;
    expect(body.corporate_candidates[0].corporate_number).toBe("1234567890123");
    expect(body.decision.choice).toBe("1234567890123");
  });
});

describe("POST /api/cards/confirm", () => {
  const payload = {
    company_name: "株式会社山田建設",
    corporate_number: "1234567890123",
    person_name: "山田太郎",
    meeting: {
      interaction_type: "meeting",
      interaction_at: "2026-09-30",
      summary: "新社屋案件について打合せ",
      next_action: "見積提出",
    },
  };

  it("creates corporation + contact + card + interaction", async () => {
    const app = createApp(makeDeps());
    const res = await app.request("/api/cards/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.deduplicated).toBe(false);
    expect(body.interaction_id).toBeTruthy();
  });

  it("suppresses duplicate corporation registration by corporate_number", async () => {
    const app = createApp(makeDeps());
    for (let i = 0; i < 2; i++) {
      await app.request("/api/cards/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, person_name: `担当${i}` }),
      });
    }
    const res = await app.request("/api/cards/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await res.json()) as any;
    expect(body.deduplicated).toBe(true);
  });

  it("validates required fields", async () => {
    const app = createApp(makeDeps());
    const res = await app.request("/api/cards/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company_name: "x" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("contact suggestion and context", () => {
  async function seeded() {
    const deps = makeDeps();
    const app = createApp(deps);
    await app.request("/api/cards/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        company_name: "株式会社山田建設",
        corporate_number: "1234567890123",
        person_name: "山田太郎",
        title: "営業部長",
        meeting: {
          interaction_type: "meeting",
          interaction_at: "2026-09-12",
          summary: "新社屋案件について打合せ",
          next_action: "工期確認・見積提出",
        },
      }),
    });
    return { deps, app };
  }

  it("suggests existing contacts by person name", async () => {
    const { app } = await seeded();
    const res = await app.request("/api/contacts/suggest?q=山田");
    const body = (await res.json()) as any;
    expect(body.contacts[0].name).toBe("山田太郎");
    expect(body.contacts[0].official_name).toBe("株式会社山田建設");
  });

  it("restores meeting context", async () => {
    const { deps } = await seeded();
    const contact = [...(deps.store as MemoryStore).contacts.values()][0];
    const app = createApp(deps);
    const res = await app.request(`/api/contacts/${contact?.person_id}/context`);
    const body = (await res.json()) as any;
    expect(body.contact.name).toBe("山田太郎");
    expect(body.recent_interactions[0].summary).toContain("新社屋案件");
    expect(body.recent_interactions[0].next_action).toContain("見積");
  });

  it("ranks recent contacts for repeat-meeting suggestion", async () => {
    const { app } = await seeded();
    const res = await app.request("/api/contacts/recent?company=山田建設");
    const body = (await res.json()) as any;
    expect(body.contacts[0].name).toBe("山田太郎");
  });
});
