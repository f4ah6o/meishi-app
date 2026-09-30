import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NullRegistry } from "@meishi/server/src/corporate/registry.ts";
import { RuleDecisionProvider } from "@meishi/server/src/decision/decision.ts";
import type { BusinessCardExtraction } from "@meishi/shared";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkerApp, type WorkerDeps } from "../src/app.ts";
import { loadWorkerConfig, type WorkerEnv } from "../src/env.ts";
import type { ImageCardExtractor } from "../src/extract/opencodeVision.ts";
import { D1Store } from "../src/store/d1Store.ts";

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

let mf: Miniflare;
let db: D1Database;

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: "test-meishi" },
  });
  db = await mf.getD1Database("DB");
  const dir = join(__dirname, "../migrations");
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const sql = readFileSync(join(dir, file), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    for (const stmt of sql.split(";")) {
      const trimmed = stmt.trim();
      if (trimmed) await db.prepare(trimmed).run();
    }
  }
});

afterAll(async () => {
  await mf.dispose();
});

class FakeExtractor implements ImageCardExtractor {
  constructor(private card: BusinessCardExtraction) {}
  async extract(): Promise<BusinessCardExtraction> {
    return this.card;
  }
}

const STUB_CARD: BusinessCardExtraction = {
  company_name_raw: "（株）山田建設",
  person_name: "山田 太郎",
  department: "営業部",
  title: "部長",
  postal_code: "100-0001",
  address: "東京都千代田区1-1",
  phone: "03-1111-2222",
  mobile: "",
  fax: "",
  email: "taro@yamada.example",
  website: "yamada.example",
  uncertain_fields: [],
};

function makeEnv(over: Partial<WorkerEnv> = {}): WorkerEnv {
  return {
    DB: db,
    ENVIRONMENT: "local",
    AUTH_MODE: "dev",
    DEV_USER_EMAIL: "dev@example.local",
    ...over,
  };
}

function makeDeps(over: Partial<WorkerDeps> = {}, env: WorkerEnv = makeEnv()): WorkerDeps {
  return {
    config: loadWorkerConfig(env),
    extractor: new FakeExtractor(STUB_CARD),
    store: new D1Store(db),
    registry: new NullRegistry(),
    decider: new RuleDecisionProvider(),
    ...over,
  };
}

const ctx = {} as ExecutionContext;
const post = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

describe("Access enforcement", () => {
  it("fails closed with 401 when no Access identity exists", async () => {
    const env = makeEnv({ ENVIRONMENT: "production", AUTH_MODE: "access" });
    const app = createWorkerApp(makeDeps({}, env));
    const res = await app.fetch(new Request("https://demo.example/api/health"), env, ctx);
    expect(res.status).toBe(401);
  });

  it("does not honor AUTH_MODE=dev outside ENVIRONMENT=local", async () => {
    const env = makeEnv({ ENVIRONMENT: "production", AUTH_MODE: "dev" });
    const app = createWorkerApp(makeDeps({}, env));
    const res = await app.fetch(new Request("https://demo.example/api/health"), env, ctx);
    expect(res.status).toBe(401);
  });

  it("accepts ctx.access identity on asset routes", async () => {
    const env = makeEnv({
      ENVIRONMENT: "production",
      ASSETS: { fetch: async () => new Response("<html>pwa</html>") } as unknown as Fetcher,
    });
    const app = createWorkerApp(makeDeps({}, env));
    const accessCtx = {
      access: { getIdentity: async () => ({ email: "user@corp.example" }) },
    } as unknown as ExecutionContext;
    const res = await app.fetch(new Request("https://demo.example/"), env, accessCtx);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("pwa");
  });

  it("rejects asset routes when ctx.access yields no identity", async () => {
    let served = false;
    const env = makeEnv({
      ENVIRONMENT: "production",
      ASSETS: {
        fetch: async () => {
          served = true;
          return new Response("ok");
        },
      } as unknown as Fetcher,
    });
    const app = createWorkerApp(makeDeps({}, env));
    const res = await app.fetch(new Request("https://demo.example/"), env, ctx);
    expect(res.status).toBe(401);
    expect(served).toBe(false);
  });
});

describe("API flows on D1", () => {
  it("analyze → confirm → context persists on D1", async () => {
    const env = makeEnv();
    const app = createWorkerApp(makeDeps({}, env));

    const analyze = await app.fetch(
      new Request("https://demo.example/api/cards/analyze", post({ image_base64: PNG_1PX })),
      env,
      ctx,
    );
    expect(analyze.status).toBe(200);
    const a = (await analyze.json()) as any;
    expect(a.extraction.company_name).toBe("株式会社山田建設");

    const confirm = await app.fetch(
      new Request(
        "https://demo.example/api/cards/confirm",
        post({
          company_name: "株式会社山田建設",
          person_name: "山田太郎",
          email: "taro@yamada.example",
          raw_extraction: JSON.stringify(STUB_CARD),
          meeting: {
            interaction_type: "meeting",
            interaction_at: "2026-09-30",
            summary: "初回名刺交換",
            next_action: "資料送付",
          },
        }),
      ),
      env,
      ctx,
    );
    expect(confirm.status).toBe(200);
    const confirmed = (await confirm.json()) as any;
    expect(confirmed.business_card_id).toBeTruthy();
    expect(confirmed.interaction_id).toBeTruthy();

    // Second confirm of the same card dedupes corporation + contact.
    const again = await app.fetch(
      new Request(
        "https://demo.example/api/cards/confirm",
        post({
          company_name: "株式会社山田建設",
          person_name: "山田太郎",
          email: "taro@yamada.example",
        }),
      ),
      env,
      ctx,
    );
    const againBody = (await again.json()) as any;
    expect(againBody.deduplicated).toBe(true);
    expect(againBody.corporation_id).toBe(confirmed.corporation_id);
    expect(againBody.person_id).toBe(confirmed.person_id);

    const context = await app.fetch(
      new Request(`https://demo.example/api/contacts/${confirmed.person_id}/context`),
      env,
      ctx,
    );
    expect(context.status).toBe(200);
    const contextBody = (await context.json()) as any;
    expect(contextBody.contact.name).toBe("山田太郎");
    expect(contextBody.recent_interactions[0].summary).toBe("初回名刺交換");

    const recent = await app.fetch(
      new Request("https://demo.example/api/contacts/recent"),
      env,
      ctx,
    );
    const recentBody = (await recent.json()) as any;
    expect(recentBody.contacts.some((ct: any) => ct.person_id === confirmed.person_id)).toBe(true);
  });

  it("returns 503 extractor_not_configured without OPENCODE_API_KEY", async () => {
    const env = makeEnv();
    const app = createWorkerApp(makeDeps({ extractor: null }, env));
    const res = await app.fetch(
      new Request("https://demo.example/api/cards/analyze", post({ image_base64: PNG_1PX })),
      env,
      ctx,
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as any;
    expect(body.error).toBe("extractor_not_configured");
  });

  it("enforces the rate limit across requests on the cached isolate app", async () => {
    // index.ts caches the app per isolate — the limiter Map must persist
    // between requests or the limit never applies.
    const worker = (await import("../src/index.ts")).default;
    const env = makeEnv({ RATE_LIMIT_PER_MINUTE: "2" });
    const first = await worker.fetch(new Request("https://demo.example/api/health"), env, ctx);
    const second = await worker.fetch(new Request("https://demo.example/api/health"), env, ctx);
    const third = await worker.fetch(new Request("https://demo.example/api/health"), env, ctx);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
  });

  it("rejects non-image payloads", async () => {
    const env = makeEnv();
    const app = createWorkerApp(makeDeps({}, env));
    const res = await app.fetch(
      new Request(
        "https://demo.example/api/cards/analyze",
        post({ image_base64: btoa("definitely not an image") }),
      ),
      env,
      ctx,
    );
    expect(res.status).toBe(415);
  });
});
