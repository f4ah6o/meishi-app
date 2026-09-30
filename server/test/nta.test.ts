import { describe, expect, it } from "vitest";
import { NtaRegistry, parseNtaXml } from "../src/corporate/nta.ts";

const XML = `<?xml version="1.0"?><corporations>
  <corporation>
    <corporateNumber>1234567890123</corporateNumber>
    <name>株式会社山田建設</name>
    <prefectureName>東京都</prefectureName>
    <cityName>千代田区</cityName>
    <streetNumber>千代田1-1</streetNumber>
  </corporation>
</corporations>`;

function fakeFetch() {
  const urls: string[] = [];
  const impl = (async (input: URL | string) => {
    urls.push(String(input));
    return new Response(XML, { status: 200 });
  }) as typeof fetch;
  return { impl, urls };
}

describe("NtaRegistry", () => {
  it("looks up a number via the /4/num endpoint with type=12", async () => {
    const { impl, urls } = fakeFetch();
    const hit = await new NtaRegistry("APPID123", impl).findByNumber("1234567890123");
    expect(hit?.official_name).toBe("株式会社山田建設");
    const url = new URL(urls[0] ?? "");
    expect(url.pathname).toBe("/4/num");
    expect(url.searchParams.get("id")).toBe("APPID123");
    expect(url.searchParams.get("number")).toBe("1234567890123");
    expect(url.searchParams.get("type")).toBe("12");
  });

  it("searches names via /4/name", async () => {
    const { impl, urls } = fakeFetch();
    await new NtaRegistry("APPID123", impl).search({ name: "山田建設" });
    expect(new URL(urls[0] ?? "").pathname).toBe("/4/name");
  });

  it("parses NTA XML into candidates", () => {
    const [c] = parseNtaXml(XML);
    expect(c?.corporate_number).toBe("1234567890123");
    expect(c?.address).toBe("東京都千代田区千代田1-1");
  });
});
