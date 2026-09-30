import type { ContactCandidate } from "@meishi/shared";
import { describe, expect, it } from "vitest";
import { rankContacts } from "../src/pipeline/ranking.ts";

const ct = (over: Partial<ContactCandidate>): ContactCandidate => ({
  person_id: "p1",
  corporation_id: "c1",
  name: "山田太郎",
  ...over,
});

describe("rankContacts", () => {
  it("ranks recent interactions higher", () => {
    const now = new Date("2026-09-30T00:00:00Z");
    const ranked = rankContacts(
      [
        ct({ person_id: "old", last_interaction_at: "2025-01-01" }),
        ct({ person_id: "recent", last_interaction_at: "2026-09-28" }),
      ],
      { now },
    );
    expect(ranked[0]?.person_id).toBe("recent");
  });

  it("boosts company-name and person-name partial matches", () => {
    const ranked = rankContacts(
      [
        ct({ person_id: "other", name: "鈴木花子", official_name: "株式会社鈴木商事" }),
        ct({ person_id: "hit", name: "山田太郎", official_name: "株式会社山田建設" }),
      ],
      { companyNameKey: "山田建設", personName: "山田" },
    );
    expect(ranked[0]?.person_id).toBe("hit");
    expect(ranked[0]?.reasons).toContain("会社名一致");
    expect(ranked[0]?.reasons).toContain("氏名一致");
  });

  it("drops zero-signal contacts", () => {
    const ranked = rankContacts(
      [ct({ person_id: "nobody", name: "佐藤", official_name: "株式会社佐藤" })],
      { companyNameKey: "山田建設" },
    );
    expect(ranked).toHaveLength(0);
  });

  it("boosts scheduled attendees and frequent contacts", () => {
    const counts = new Map([["freq", 8]]);
    const ranked = rankContacts(
      [
        ct({ person_id: "freq", last_interaction_at: "2026-06-01" }),
        ct({ person_id: "sched", last_interaction_at: "2026-06-01" }),
      ],
      {
        scheduledPersonIds: ["sched"],
        interactionCounts: counts,
        now: new Date("2026-09-30T00:00:00Z"),
      },
    );
    expect(ranked[0]?.person_id).toBe("sched");
  });
});
