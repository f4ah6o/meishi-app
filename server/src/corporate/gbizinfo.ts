import type { CorporationCandidate } from "@meishi/shared";
import type { CorporateRegistry, CorporateSearchQuery } from "./registry.ts";

/**
 * gBizINFO REST API.
 *   GET https://info.gbiz.go.jp/hojin/v1/hojin?name=<name>&page=1&limit=20
 *   Header: X-hojinInfo-api-token: <token>
 * Requires GBIZINFO_API_TOKEN (free application on the gBizINFO site).
 */
export class GbizinfoRegistry implements CorporateRegistry {
  constructor(
    private readonly apiToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async search(query: CorporateSearchQuery): Promise<CorporationCandidate[]> {
    if (!this.apiToken || !query.name) return [];
    const url = new URL("https://info.gbiz.go.jp/hojin/v1/hojin");
    url.searchParams.set("name", query.name);
    url.searchParams.set("page", "1");
    url.searchParams.set("limit", "20");
    const res = await this.fetchImpl(url, {
      headers: { "X-hojinInfo-api-token": this.apiToken, Accept: "application/json" },
    });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`gBizINFO API failed: ${res.status}`);
    const body = (await res.json()) as { "hojin-infos"?: GbizinfoEntry[] };
    return (body["hojin-infos"] ?? []).map((e) => this.toCandidate(e));
  }

  /** Number lookup: GET /hojin/v1/hojin/{corporate_number} */
  async findByNumber(corporateNumber: string): Promise<CorporationCandidate | null> {
    if (!this.apiToken || !/^\d{13}$/.test(corporateNumber)) return null;
    const url = new URL(`https://info.gbiz.go.jp/hojin/v1/hojin/${corporateNumber}`);
    const res = await this.fetchImpl(url, {
      headers: { "X-hojinInfo-api-token": this.apiToken, Accept: "application/json" },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`gBizINFO API failed: ${res.status}`);
    const body = (await res.json()) as {
      "hojin-infos"?: GbizinfoEntry | GbizinfoEntry[];
    };
    const infos = body["hojin-infos"];
    const entry = Array.isArray(infos) ? infos[0] : infos;
    return entry ? this.toCandidate(entry) : null;
  }

  private toCandidate(e: GbizinfoEntry): CorporationCandidate {
    return {
      source: "gbizinfo",
      corporate_number: e.corporate_number,
      official_name: e.name,
      prefecture: e.prefecture_name ?? e.location?.split(/[都道府県]/)[0],
      city: e.city_name,
      address: e.location,
      website: e.company_url,
    };
  }
}

interface GbizinfoEntry {
  corporate_number: string;
  name: string;
  name_kana?: string;
  name_en?: string;
  postal_code?: string;
  location?: string;
  prefecture_name?: string;
  city_name?: string;
  company_url?: string;
}
