import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  async findByNumber(corporateNumber: string): Promise<CorporationCandidate | null> {
    return this.candidates.find((c) => c.corporate_number === corporateNumber) ?? null;
  }
}

/** Registry that cannot verify numbers (no findByNumber). */
class NumberlessRegistry implements CorporateRegistry {
  async search(): Promise<CorporationCandidate[]> {
    return [];
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

  it("rejects a malformed corporate_number", async () => {
    const app = createApp(makeDeps());
    const res = await app.request("/api/cards/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, corporate_number: "123" }),
    });
    expect(res.status).toBe(400);
  });

  it("marks the corporation verified only when the number resolves", async () => {
    const deps = makeDeps({
      registry: new FakeRegistry([
        { source: "nta", corporate_number: "1234567890123", official_name: "株式会社山田建設" },
      ]),
    });
    const res = await createApp(deps).request("/api/cards/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await res.json()) as any;
    expect(body.corporation_verified).toBe(true);
    const corp = [...(deps.store as MemoryStore).corporations.values()][0];
    expect(corp?.verification_status).toBe("verified");
  });

  it("marks verified when the number already exists in kintone", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    await app.request("/api/cards/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const res = await app.request("/api/cards/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, person_name: "別担当" }),
    });
    expect(((await res.json()) as any).corporation_verified).toBe(true);
  });

  it("keeps an unverifiable corporate_number unverified", async () => {
    const deps = makeDeps({ registry: new NumberlessRegistry() });
    const res = await createApp(deps).request("/api/cards/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(body.corporation_verified).toBe(false);
    const corp = [...(deps.store as MemoryStore).corporations.values()][0];
    expect(corp?.verification_status).toBe("unverified");
  });

  it("does not alias a same-name corporation with a different number", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    await app.request("/api/cards/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const res = await app.request("/api/cards/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, corporate_number: "9999999999999" }),
    });
    const body = (await res.json()) as any;
    expect(body.deduplicated).toBe(false);
    expect((deps.store as MemoryStore).corporations.size).toBe(2);
  });

  it("stores an empty image_reference with ephemeral retention", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    const res = await app.request("/api/cards/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, corporation_id: "forged-id" }),
    });
    expect(res.status).toBe(200);
    const card = [...(deps.store as MemoryStore).cards.values()][0];
    expect(card?.image_reference).toBe("");
  });

  it("attaches a verified corporate_number to an unnumbered same-name record", async () => {
    const store = new MemoryStore();
    await store.getOrCreateCorporation({
      officialName: "株式会社山田建設",
      verificationStatus: "unverified",
    });
    const deps = makeDeps({
      store,
      registry: new FakeRegistry([
        { source: "nta", corporate_number: "1234567890123", official_name: "株式会社山田建設" },
      ]),
    });
    const res = await createApp(deps).request("/api/cards/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await res.json()) as any;
    expect(body.deduplicated).toBe(true);
    expect(body.corporation_verified).toBe(true);
    expect(store.corporations.size).toBe(1);
    const corp = [...store.corporations.values()][0];
    expect(corp?.corporate_number).toBe("1234567890123");
    expect(corp?.verification_status).toBe("verified");
  });

  it("does not reuse a numbered corporation for an explicit no-number choice", async () => {
    const store = new MemoryStore();
    await store.getOrCreateCorporation({
      officialName: "株式会社山田建設",
      corporateNumber: "1234567890123",
      verificationStatus: "verified",
    });
    const deps = makeDeps({ store });
    const { corporate_number: _omit, ...noNumber } = payload;
    const res = await createApp(deps).request("/api/cards/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(noNumber),
    });
    const body = (await res.json()) as any;
    expect(body.deduplicated).toBe(false);
    expect(store.corporations.size).toBe(2);
    const created = [...store.corporations.values()].find((c) => !c.corporate_number);
    expect(created?.verification_status).toBe("unverified");
  });

  it("rejects a corporate_number that disagrees with an existing record's name", async () => {
    const store = new MemoryStore();
    await store.getOrCreateCorporation({
      officialName: "株式会社別会社",
      corporateNumber: "1234567890123",
      verificationStatus: "verified",
    });
    const res = await createApp(makeDeps({ store })).request("/api/cards/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(409);
    expect(store.corporations.size).toBe(1);
  });

  it("rejects a corporate_number whose registry name disagrees", async () => {
    const deps = makeDeps({
      registry: new FakeRegistry([
        { source: "nta", corporate_number: "1234567890123", official_name: "株式会社別会社" },
      ]),
    });
    const res = await createApp(deps).request("/api/cards/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(409);
    expect((deps.store as MemoryStore).corporations.size).toBe(0);
  });

  it("adopts the authoritative registry name for a verified number", async () => {
    const deps = makeDeps({
      registry: new FakeRegistry([
        { source: "nta", corporate_number: "1234567890123", official_name: "株式会社山田建設" },
      ]),
    });
    const res = await createApp(deps).request("/api/cards/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, company_name: "山田建設" }),
    });
    const body = (await res.json()) as any;
    expect(body.corporation_verified).toBe(true);
    const corp = [...(deps.store as MemoryStore).corporations.values()][0];
    expect(corp?.official_name).toBe("株式会社山田建設");
  });

  it("creates a new record rather than attaching an unverifiable number", async () => {
    const store = new MemoryStore();
    await store.getOrCreateCorporation({
      officialName: "株式会社山田建設",
      verificationStatus: "unverified",
    });
    const deps = makeDeps({ store, registry: new NumberlessRegistry() });
    const res = await createApp(deps).request("/api/cards/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await res.json()) as any;
    expect(body.deduplicated).toBe(false);
    expect(body.corporation_verified).toBe(false);
    expect(store.corporations.size).toBe(2);
  });

  it("does not merge same-name contacts with conflicting emails", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    for (const email of ["a@yamada.co.jp", "b@yamada.co.jp"]) {
      await app.request("/api/cards/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, email }),
      });
    }
    expect((deps.store as MemoryStore).contacts.size).toBe(2);
  });

  it("dedupes a same-name contact and backfills missing identifiers", async () => {
    const deps = makeDeps();
    const app = createApp(deps);
    await app.request("/api/cards/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const res = await app.request("/api/cards/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, email: "taro@yamada.co.jp" }),
    });
    expect(res.status).toBe(200);
    expect((deps.store as MemoryStore).contacts.size).toBe(1);
    const contact = [...(deps.store as MemoryStore).contacts.values()][0];
    expect(contact?.email).toBe("taro@yamada.co.jp");
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

describe("public registry search on non-decisive kintone matches", () => {
  it("keeps searching public data when kintone has only a partial name match", async () => {
    const store = new MemoryStore();
    // Same-name-key prefix is a substring match, not a decisive entity match.
    await store.getOrCreateCorporation({
      officialName: "株式会社山田建設興業",
      corporateNumber: "5555555555555",
      verificationStatus: "verified",
    });
    const registry = new FakeRegistry([
      { source: "nta", corporate_number: "1234567890123", official_name: "株式会社山田建設" },
    ]);
    const app = createApp(makeDeps({ store, registry }));
    const res = await app.request("/api/cards/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_base64: PNG_1PX }),
    });
    const body = (await res.json()) as any;
    const numbers = body.corporate_candidates.map((c: CorporationCandidate) => c.corporate_number);
    expect(numbers).toContain("5555555555555");
    expect(numbers).toContain("1234567890123");
  });
});

describe("static web serving", () => {
  function webDistDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "meishi-web-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>meishi</title>");
    writeFileSync(join(dir, "manifest.webmanifest"), "{}");
    return dir;
  }

  it("serves index.html at / and on SPA fallback routes", async () => {
    const app = createApp(makeDeps({ config: makeConfig({ webDist: webDistDir() }) }));
    const root = await app.request("/");
    expect(root.status).toBe(200);
    expect(await root.text()).toContain("meishi");
    const spa = await app.request("/confirm/some-path");
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain("meishi");
  });

  it("serves static assets", async () => {
    const app = createApp(makeDeps({ config: makeConfig({ webDist: webDistDir() }) }));
    const res = await app.request("/manifest.webmanifest");
    expect(res.status).toBe(200);
  });

  it("returns JSON 404 for unknown /api routes, not the SPA", async () => {
    const app = createApp(makeDeps({ config: makeConfig({ webDist: webDistDir() }) }));
    const res = await app.request("/api/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("404s cleanly when no web dist exists", async () => {
    const app = createApp(
      makeDeps({ config: makeConfig({ webDist: join(tmpdir(), "no-such-dist") }) }),
    );
    const res = await app.request("/");
    expect(res.status).toBe(404);
  });
});
