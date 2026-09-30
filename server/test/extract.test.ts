import { describe, expect, it } from "vitest";
import { parseExtractionJson } from "../src/extract/cardExtractor.ts";

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
