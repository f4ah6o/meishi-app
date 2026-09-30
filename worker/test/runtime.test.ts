import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { MockAgent } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const CARD = {
  company_name_raw: "（株）山田建設",
  person_name: "山田 太郎",
  department: "営業部",
  title: "部長",
  postal_code: "",
  address: "",
  phone: "03-1111-2222",
  mobile: "",
  fax: "",
  email: "",
  website: "",
  uncertain_fields: [],
};

let mf: Miniflare;

beforeAll(async () => {
  // Bundle the real Worker entry so the test runs inside workerd — vitest's
  // Node fetch does not care about the call receiver, so only workerd
  // reproduces the "Illegal invocation" failure this test guards against.
  const esbuild = await import("esbuild");
  // Must live under the repo root — workerd refuses script paths that escape
  // the Miniflare working directory.
  const outdir = join(__dirname, "../.dist-check");
  mkdirSync(outdir, { recursive: true });
  const script = join(outdir, "runtime-index.mjs");
  await esbuild.build({
    entryPoints: [join(__dirname, "../src/index.ts")],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    outfile: script,
  });

  const mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  mockAgent
    .get("https://opencode.ai")
    .intercept({ path: "/zen/go/v1/chat/completions", method: "POST" })
    .reply(
      200,
      JSON.stringify({
        choices: [
          {
            finish_reason: "stop",
            message: { content: JSON.stringify(CARD) },
          },
        ],
      }),
      { headers: { "Content-Type": "application/json" } },
    );

  mf = new Miniflare({
    modules: true,
    scriptPath: script,
    // Same as wrangler.toml — Hono's body-limit middleware needs
    // streams_enable_constructors, on by default at this date.
    compatibilityDate: "2025-09-11",
    d1Databases: { DB: "test-meishi-rt" },
    fetchMock: mockAgent,
    bindings: {
      ENVIRONMENT: "local",
      AUTH_MODE: "dev",
      DEV_USER_EMAIL: "dev@example.local",
      OPENCODE_API_KEY: "rt-test-key",
    },
  });
  const db = await mf.getD1Database("DB");
  const sql = readFileSync(join(__dirname, "../migrations/0001_init.sql"), "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
  for (const stmt of sql.split(";")) {
    const trimmed = stmt.trim();
    if (trimmed) await db.prepare(trimmed).run();
  }
});

afterAll(async () => {
  await mf.dispose();
});

describe("Worker runtime (workerd)", () => {
  it("analyzes a card through the default global fetch path", async () => {
    // Regression: OpenCodeVisionExtractor must invoke Workers global fetch on
    // its proper receiver; calling a stored bare `fetch` via `this.fetchImpl`
    // threw "Illegal invocation" and 502'd /api/cards/analyze in production.
    const res = await mf.dispatchFetch("http://localhost/api/cards/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_base64: PNG_1PX }),
    });
    const body = (await res.json()) as {
      error?: string;
      extraction?: { company_name?: string; person_name?: string };
    };
    expect(res.status).toBe(200);
    expect(body.extraction?.person_name).toBe("山田 太郎");
  });
});
