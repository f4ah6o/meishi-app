import type { CorporationCandidate } from "@meishi/shared";
import type { CorporateRegistry, CorporateSearchQuery } from "./registry.ts";

/**
 * 国税庁 法人番号公表サイト Web-API (v4).
 *   GET https://api.houjin-bangou.nta.go.jp/4/name?id=<appId>&name=<name>&mode=2&type=12&change=0
 *   mode: 1=部分一致? — mode=2 is the commonly documented partial-match search.
 *   type: 12 = XML/Unicode. Fields: corporateNumber, name, prefectureName,
 *         cityName, streetNumber, postCode, ...
 * Requires NTA_APP_ID (13-digit application id, issued by the NTA by mail after
 * a free application).
 */
export class NtaRegistry implements CorporateRegistry {
  constructor(
    private readonly appId: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async search(query: CorporateSearchQuery): Promise<CorporationCandidate[]> {
    if (!this.appId || !query.name) return [];
    const url = new URL("https://api.houjin-bangou.nta.go.jp/4/name");
    url.searchParams.set("id", this.appId);
    url.searchParams.set("name", query.name);
    url.searchParams.set("mode", "2");
    url.searchParams.set("target", "1");
    url.searchParams.set("change", "0");
    url.searchParams.set("type", "12");
    const res = await this.fetchImpl(url);
    if (!res.ok) throw new Error(`NTA API failed: ${res.status}`);
    const xml = await res.text();
    return parseNtaXml(xml);
  }

  /** Number lookup: GET /4/num?id=<appId>&number=<13digits>&type=12 */
  async findByNumber(corporateNumber: string): Promise<CorporationCandidate | null> {
    if (!this.appId || !/^\d{13}$/.test(corporateNumber)) return null;
    const url = new URL("https://api.houjin-bangou.nta.go.jp/4/num");
    url.searchParams.set("id", this.appId);
    url.searchParams.set("number", corporateNumber);
    url.searchParams.set("type", "12");
    const res = await this.fetchImpl(url);
    if (!res.ok) throw new Error(`NTA API failed: ${res.status}`);
    const xml = await res.text();
    return parseNtaXml(xml)[0] ?? null;
  }
}

/** Flat-field XML extraction — the NTA payload has no nested attributes we need. */
export function parseNtaXml(xml: string): CorporationCandidate[] {
  const out: CorporationCandidate[] = [];
  const blocks = xml.match(/<corporation>[\s\S]*?<\/corporation>/g) ?? [];
  for (const block of blocks) {
    const get = (tag: string) => {
      const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
      return m?.[1]?.replace(/<!\[CDATA\[|\]\]>/g, "").trim() ?? "";
    };
    const corporateNumber = get("corporateNumber");
    const name = get("name");
    if (!corporateNumber || !name) continue;
    out.push({
      source: "nta",
      corporate_number: corporateNumber,
      official_name: name,
      prefecture: get("prefectureName"),
      city: get("cityName"),
      address: `${get("prefectureName")}${get("cityName")}${get("streetNumber")}`,
    });
  }
  return out;
}
