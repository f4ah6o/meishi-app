import { describe, expect, it } from "vitest";
import { OpenCodeVisionExtractor } from "../src/extract/opencodeVision.ts";

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

function extractorWith(handler: (url: string, init: RequestInit) => Promise<Response>) {
  return new OpenCodeVisionExtractor({
    baseUrl: "https://opencode.ai/zen/go/v1",
    apiKey: "test-key",
    model: "deepseek-v4-flash-vision-exp",
    timeoutMs: 5000,
    fetchImpl: handler as typeof fetch,
  });
}

const JSON_PAYLOAD = {
  company_name_raw: "（株）山田建設",
  person_name: "山田 太郎",
  department: "営業部",
  title: "部長",
  postal_code: "100-0001",
  address: "東京都千代田区",
  phone: "03-1111-2222",
  mobile: "",
  fax: "",
  email: "taro@yamada.example",
  website: "yamada.example",
  uncertain_fields: [],
};

function chatResponse(content: string, finishReason = "stop") {
  return new Response(
    JSON.stringify({
      choices: [{ finish_reason: finishReason, message: { content } }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("OpenCodeVisionExtractor", () => {
  it("sends the documented chat/completions shape with the image as a content part", async () => {
    const seen = {} as { url: string; auth: string; body: any };
    const ex = extractorWith(async (url, init) => {
      seen.url = url;
      seen.auth = (init.headers as Record<string, string>).Authorization ?? "";
      seen.body = JSON.parse(init.body as string);
      return chatResponse(JSON.stringify(JSON_PAYLOAD));
    });
    const card = await ex.extract({ bytes: JPEG_BYTES, mediaType: "image/jpeg" });
    expect(card.person_name).toBe("山田 太郎");
    expect(seen.url).toBe("https://opencode.ai/zen/go/v1/chat/completions");
    expect(seen.auth).toBe("Bearer test-key");
    expect(seen.body.model).toBe("deepseek-v4-flash-vision-exp");
    expect(seen.body.max_tokens).toBeGreaterThanOrEqual(1500);
    const parts = seen.body.messages[0].content;
    expect(parts[0].type).toBe("text");
    expect(parts[1].type).toBe("image_url");
    expect(parts[1].image_url.url).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("parses fenced JSON output", async () => {
    const ex = extractorWith(async () =>
      chatResponse(`\`\`\`json\n${JSON.stringify(JSON_PAYLOAD)}\n\`\`\``),
    );
    const card = await ex.extract({ bytes: JPEG_BYTES, mediaType: "image/jpeg" });
    expect(card.company_name_raw).toBe("（株）山田建設");
  });

  it("treats finish_reason=length (empty content after reasoning) as failure", async () => {
    const ex = extractorWith(async () => chatResponse("", "length"));
    await expect(ex.extract({ bytes: JPEG_BYTES, mediaType: "image/jpeg" })).rejects.toThrow(
      /truncated/i,
    );
  });

  it("treats empty content as failure, never a fabricated extraction", async () => {
    const ex = extractorWith(async () => chatResponse(""));
    await expect(ex.extract({ bytes: JPEG_BYTES, mediaType: "image/jpeg" })).rejects.toThrow();
  });

  it("propagates non-2xx responses as errors", async () => {
    const ex = extractorWith(async () => new Response("unauthorized", { status: 401 }));
    await expect(ex.extract({ bytes: JPEG_BYTES, mediaType: "image/jpeg" })).rejects.toThrow(/401/);
  });

  it("rejects malformed extraction payloads", async () => {
    const ex = extractorWith(async () => chatResponse("not json at all"));
    await expect(ex.extract({ bytes: JPEG_BYTES, mediaType: "image/jpeg" })).rejects.toThrow();
  });
});
