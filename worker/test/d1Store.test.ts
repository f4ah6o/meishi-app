import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { D1Store } from "../src/store/d1Store.ts";

const MIGRATION = join(__dirname, "../migrations/0001_init.sql");

/** Split the migration into single statements — D1 exec is picky about
 *  comments/multi-line dumps; wrangler's migrator tolerates them. */
export async function applyMigrations(db: D1Database, path = MIGRATION): Promise<void> {
  const sql = readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
  for (const stmt of sql.split(";")) {
    const trimmed = stmt.trim();
    if (trimmed) await db.prepare(trimmed).run();
  }
}

let mf: Miniflare;
let db: D1Database;
let store: D1Store;

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { DB: "test-meishi" },
  });
  db = await mf.getD1Database("DB");
  // Same migration file as production — keeps tests honest about the schema.
  await applyMigrations(db);
  store = new D1Store(db);
});

afterAll(async () => {
  await mf.dispose();
});

describe("D1Store corporations", () => {
  it("dedupes on corporate_number", async () => {
    const first = await store.getOrCreateCorporation({
      officialName: "株式会社山田建設",
      corporateNumber: "1234567890123",
      verificationStatus: "verified",
    });
    const second = await store.getOrCreateCorporation({
      officialName: "株式会社山田建設",
      corporateNumber: "1234567890123",
      verificationStatus: "verified",
    });
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.corporationId).toBe(first.corporationId);
  });

  it("never aliases a same-name corporation with a different number", async () => {
    const a = await store.getOrCreateCorporation({
      officialName: "株式会社田中工業",
      corporateNumber: "1111111111111",
      verificationStatus: "verified",
    });
    const b = await store.getOrCreateCorporation({
      officialName: "株式会社田中工業",
      corporateNumber: "2222222222222",
      verificationStatus: "verified",
    });
    expect(b.deduplicated).toBe(false);
    expect(b.corporationId).not.toBe(a.corporationId);
  });

  it("dedupes unnumbered same-name corporations by normalized name key", async () => {
    const first = await store.getOrCreateCorporation({
      officialName: "（株）佐藤商店",
      verificationStatus: "unverified",
    });
    const second = await store.getOrCreateCorporation({
      officialName: "株式会社佐藤商店",
      verificationStatus: "unverified",
    });
    expect(second.deduplicated).toBe(true);
    expect(second.corporationId).toBe(first.corporationId);
  });

  it("upgrades an unnumbered same-name record when a verified number arrives", async () => {
    const first = await store.getOrCreateCorporation({
      officialName: "株式会社鈴木工務店",
      verificationStatus: "unverified",
    });
    const second = await store.getOrCreateCorporation({
      officialName: "株式会社鈴木工務店",
      corporateNumber: "3333333333333",
      verificationStatus: "verified",
    });
    expect(second.deduplicated).toBe(true);
    expect(second.corporationId).toBe(first.corporationId);
    const found = await store.findCorporationByNumber("3333333333333");
    expect(found?.official_name).toBe("株式会社鈴木工務店");
    expect(found?.verification_status).toBe("verified");
  });

  it("searches corporations by name key substring", async () => {
    const results = await store.searchCorporationsByName("山田建設");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]?.official_name).toBe("株式会社山田建設");
  });
});

describe("D1Store contacts / cards / interactions", () => {
  it("merges contacts only on a matching identifier", async () => {
    const corp = await store.getOrCreateCorporation({
      officialName: "株式会社高橋物産",
      verificationStatus: "unverified",
    });
    const first = await store.getOrCreateContact({
      corporationId: corp.corporationId,
      name: "高橋 一郎",
      email: "ichiro@takahashi.example",
    });
    // Same normalized name + same email → merge (and backfill phone).
    const merged = await store.getOrCreateContact({
      corporationId: corp.corporationId,
      name: "高橋一郎",
      email: "ICHIRO@takahashi.example",
      phone: "03-1234-5678",
    });
    expect(merged.deduplicated).toBe(true);
    expect(merged.personId).toBe(first.personId);
    // Same name, conflicting email → distinct person.
    const other = await store.getOrCreateContact({
      corporationId: corp.corporationId,
      name: "高橋 一郎",
      email: "other@takahashi.example",
    });
    expect(other.deduplicated).toBe(false);
    expect(other.personId).not.toBe(first.personId);
    // Backfilled phone persisted.
    const contact = await store.getContact(first.personId);
    expect(contact?.person_id).toBe(first.personId);
  });

  it("persists business-card fields and serves contact context", async () => {
    const corp = await store.getOrCreateCorporation({
      officialName: "株式会社伊藤設計",
      verificationStatus: "unverified",
    });
    const person = await store.getOrCreateContact({
      corporationId: corp.corporationId,
      name: "伊藤 花子",
      email: "hanako@ito.example",
    });
    const card = await store.createBusinessCard({
      personId: person.personId,
      corporationId: corp.corporationId,
      imageReference: "",
      rawExtraction: '{"person_name":"伊藤 花子"}',
      confirmedData: '{"person_name":"伊藤 花子","company_name":"株式会社伊藤設計"}',
      decisionConfidence: 0.9,
      reviewStatus: "confirmed",
    });
    const interaction = await store.createInteraction({
      corporationId: corp.corporationId,
      personId: person.personId,
      interactionType: "meeting",
      interactionAt: "2026-09-30",
      summary: "名刺交換",
      nextAction: "資料送付",
    });
    // Raw row check: extracted + confirmed payloads actually persisted.
    const row = await db
      .prepare(
        "SELECT raw_extraction, confirmed_data, review_status FROM business_cards WHERE business_card_id = ?",
      )
      .bind(card.businessCardId)
      .first<{ raw_extraction: string; confirmed_data: string; review_status: string }>();
    expect(row?.raw_extraction).toContain("伊藤 花子");
    expect(row?.confirmed_data).toContain("株式会社伊藤設計");
    expect(row?.review_status).toBe("confirmed");

    const interactions = await store.listInteractions({ personId: person.personId });
    expect(interactions[0]?.interaction_id).toBe(interaction.interactionId);

    const recent = await store.listRecentContacts(10);
    const hit = recent.find((c) => c.person_id === person.personId);
    expect(hit?.last_interaction_at).toBe("2026-09-30");
    expect(hit?.official_name).toBe("株式会社伊藤設計");
  });

  it("searches contacts by person and company keys", async () => {
    const byPerson = await store.searchContacts({ personName: "花子" });
    expect(byPerson.some((c) => c.name.includes("伊藤"))).toBe(true);
    const byCompany = await store.searchContacts({ companyNameKey: "伊藤設計" });
    expect(byCompany.some((c) => c.name.includes("伊藤"))).toBe(true);
  });
});
