import { describe, expect, it } from "vitest";
import {
  companyNameKey,
  extractDomain,
  normalizeCard,
  normalizeCompanyName,
  normalizeEmail,
  normalizePhone,
  normalizePostalCode,
  normalizeWebsite,
} from "../src/normalize/normalize.ts";

describe("normalizeCompanyName", () => {
  it("canonicalizes leading （株）", () => {
    expect(normalizeCompanyName("（株）山田建設")).toBe("株式会社山田建設");
  });
  it("canonicalizes ㈱", () => {
    expect(normalizeCompanyName("㈱山田建設")).toBe("株式会社山田建設");
  });
  it("moves trailing （株） to the front", () => {
    expect(normalizeCompanyName("山田建設（株）")).toBe("株式会社山田建設");
  });
  it("leaves full form untouched", () => {
    expect(normalizeCompanyName("株式会社山田建設")).toBe("株式会社山田建設");
  });
  it("handles （有）", () => {
    expect(normalizeCompanyName("（有）田中商店")).toBe("有限会社田中商店");
  });
  it("strips whitespace and full-width variants", () => {
    expect(normalizeCompanyName(" （株） 山田建設 ")).toBe("株式会社山田建設");
  });
});

describe("companyNameKey", () => {
  it("strips legal form for matching", () => {
    expect(companyNameKey("（株）山田建設")).toBe("山田建設");
    expect(companyNameKey("株式会社山田建設")).toBe("山田建設");
    expect(companyNameKey("山田建設")).toBe("山田建設");
  });
});

describe("normalizePostalCode", () => {
  it("handles various forms", () => {
    expect(normalizePostalCode("〒100-0001")).toBe("100-0001");
    expect(normalizePostalCode("1000001")).toBe("100-0001");
    expect(normalizePostalCode("１００−０００１")).toBe("100-0001");
    expect(normalizePostalCode("123")).toBe("");
  });
});

describe("normalizePhone", () => {
  it("formats landline", () => {
    expect(normalizePhone("03-1234-5678")).toBe("03-1234-5678");
    expect(normalizePhone("0312345678")).toBe("03-1234-5678");
    expect(normalizePhone("０３−１２３４−５６７８")).toBe("03-1234-5678");
  });
  it("formats mobile", () => {
    expect(normalizePhone("09012345678")).toBe("090-1234-5678");
  });
  it("keeps international prefix", () => {
    expect(normalizePhone("+81-3-1234-5678")).toBe("+81312345678");
  });
});

describe("normalizeEmail / website / domain", () => {
  it("lowercases email", () => {
    expect(normalizeEmail(" Taro.Yamada@Example.CO.JP ")).toBe("taro.yamada@example.co.jp");
  });
  it("adds scheme and lowercases host", () => {
    expect(normalizeWebsite("WWW.Example.co.jp/Path")).toBe("https://www.example.co.jp/Path");
  });
  it("extracts domain from website then email", () => {
    expect(extractDomain("https://www.yamada.co.jp", "")).toBe("yamada.co.jp");
    expect(extractDomain("", "a@b.co.jp")).toBe("b.co.jp");
    expect(extractDomain("", "")).toBeNull();
  });
});

describe("normalizeCard", () => {
  it("normalizes a whole extraction deterministically", () => {
    const card = normalizeCard({
      company_name_raw: "㈱山田建設",
      person_name: "山田　太郎",
      department: "営業部",
      title: "部長",
      postal_code: "1000001",
      address: "東京都千代田区",
      phone: "0312345678",
      mobile: "09011112222",
      fax: "",
      email: "A@Yamada.co.jp",
      website: "yamada.co.jp",
      uncertain_fields: [],
    });
    expect(card.company_name).toBe("株式会社山田建設");
    expect(card.company_name_key).toBe("山田建設");
    expect(card.postal_code).toBe("100-0001");
    expect(card.phone).toBe("03-1234-5678");
    expect(card.mobile).toBe("090-1111-2222");
    expect(card.domain).toBe("yamada.co.jp");
  });
});
