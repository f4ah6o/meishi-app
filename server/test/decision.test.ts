import type { CorporationCandidate, NormalizedCard } from "@meishi/shared";
import { describe, expect, it } from "vitest";
import { nameSimilarity, RuleDecisionProvider } from "../src/decision/decision.ts";
import { normalizeCard } from "../src/normalize/normalize.ts";

const card = (over: Partial<NormalizedCard> = {}): NormalizedCard =>
  ({
    ...normalizeCard({
      company_name_raw: "（株）山田建設",
      person_name: "山田太郎",
      department: "",
      title: "",
      postal_code: "",
      address: "東京都千代田区千代田1-1",
      phone: "",
      mobile: "",
      fax: "",
      email: "",
      website: "yamada.co.jp",
      uncertain_fields: [],
    }),
    ...over,
  }) as NormalizedCard;

const corp = (over: Partial<CorporationCandidate>): CorporationCandidate => ({
  source: "nta",
  corporate_number: "1234567890123",
  official_name: "株式会社山田建設",
  ...over,
});

describe("nameSimilarity", () => {
  it("ignores legal form differences", () => {
    expect(nameSimilarity("（株）山田建設", "株式会社山田建設")).toBe(1);
  });
  it("scores partial overlap", () => {
    expect(nameSimilarity("山田建設", "山田建設工業")).toBeGreaterThan(0.7);
    expect(nameSimilarity("山田建設", "鈴木商事")).toBeLessThan(0.4);
  });
});

describe("RuleDecisionProvider", () => {
  const decider = new RuleDecisionProvider();

  it("picks a single matching candidate with high confidence", async () => {
    const result = await decider.decide({
      card: card(),
      existingContacts: [],
      corporateCandidates: [corp({ website: "yamada.co.jp" })],
    });
    expect(result.choice).toBe("1234567890123");
    expect(result.confidence).toBeGreaterThan(0.85);
  });

  it("returns none when nothing matches", async () => {
    const result = await decider.decide({
      card: card(),
      existingContacts: [],
      corporateCandidates: [corp({ official_name: "株式会社鈴木商事" })],
    });
    expect(result.choice).toBe("none");
  });

  it("never auto-confirms ambiguous multiple candidates", async () => {
    const candidates = [
      corp({ corporate_number: "1", official_name: "株式会社山田建設" }),
      corp({ corporate_number: "2", official_name: "株式会社山田建設工業" }),
    ];
    const decision = await decider.decide({
      card: card(),
      existingContacts: [],
      corporateCandidates: candidates,
    });
    expect(
      decider.isAutoConfirmable(decision, {
        card: card(),
        existingContacts: [],
        corporateCandidates: candidates,
      }),
    ).toBe(false);
  });

  it("never auto-confirms when extraction had uncertain fields", async () => {
    const decision = await decider.decide({
      card: card({ uncertain_fields: ["company_name_raw"] }),
      existingContacts: [],
      corporateCandidates: [corp({ website: "yamada.co.jp" })],
    });
    expect(
      decider.isAutoConfirmable(decision, {
        card: card({ uncertain_fields: ["company_name_raw"] }),
        existingContacts: [],
        corporateCandidates: [corp({ website: "yamada.co.jp" })],
      }),
    ).toBe(false);
  });
});
