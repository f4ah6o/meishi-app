import type { BusinessCardExtraction } from "@meishi/shared";
import type { CardExtractor } from "./cardExtractor.ts";

/**
 * Deterministic extractor for local development and tests — no AI needed.
 * Enabled with CARD_EXTRACTOR=stub.
 */
export class StubExtractor implements CardExtractor {
  constructor(private readonly fixed?: Partial<BusinessCardExtraction>) {}

  async extract(_imagePath: string): Promise<BusinessCardExtraction> {
    return {
      company_name_raw: "（株）山田建設",
      person_name: "山田 太郎",
      department: "営業部",
      title: "営業部長",
      postal_code: "1000001",
      address: "東京都千代田区千代田1-1",
      phone: "03-1234-5678",
      mobile: "",
      fax: "",
      email: "taro.yamada@yamada-kensetsu.co.jp",
      website: "https://www.yamada-kensetsu.co.jp",
      uncertain_fields: [],
      ...this.fixed,
    };
  }
}
