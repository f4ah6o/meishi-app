import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseExtractionJson } from "../src/extract/cardExtractor.ts";
import { CodexAppServerExtractor } from "../src/extract/codexAppServer.ts";

const FAKE_CODEX = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));

describe("parseExtractionJson", () => {
  it("parses a bare JSON object", () => {
    const out = parseExtractionJson(
      '{"company_name_raw":"（株）山田建設","person_name":"山田太郎"}',
    );
    expect(out.company_name_raw).toBe("（株）山田建設");
    expect(out.uncertain_fields).toEqual([]);
  });

  it("parses JSON inside a code fence with prose", () => {
    const text =
      '結果はこちらです。\n```json\n{"email":"a@b.co.jp","uncertain_fields":["fax"]}\n```';
    const out = parseExtractionJson(text);
    expect(out.email).toBe("a@b.co.jp");
    expect(out.uncertain_fields).toEqual(["fax"]);
  });

  it("fills missing fields with empty strings", () => {
    const out = parseExtractionJson("{}");
    expect(out.company_name_raw).toBe("");
    expect(out.mobile).toBe("");
  });

  it("rejects non-JSON output", () => {
    expect(() => parseExtractionJson("名刺を読み取れませんでした")).toThrow();
  });
});

describe("CodexAppServerExtractor", () => {
  const image = join(FAKE_CODEX, "..", "card.png");

  it("rejects an interrupted turn even after an agentMessage", async () => {
    process.env.FAKE_TURN_STATUS = "interrupted";
    const extractor = new CodexAppServerExtractor({
      bin: FAKE_CODEX,
      model: null,
      timeoutMs: 10_000,
    });
    await expect(extractor.extract(image)).rejects.toThrow(/interrupted/i);
  });

  it("extracts on a completed turn", async () => {
    process.env.FAKE_TURN_STATUS = "completed";
    const extractor = new CodexAppServerExtractor({
      bin: FAKE_CODEX,
      model: null,
      timeoutMs: 10_000,
    });
    const out = await extractor.extract(image);
    expect(out.person_name).toBe("山田太郎");
    delete process.env.FAKE_TURN_STATUS;
  });
});
