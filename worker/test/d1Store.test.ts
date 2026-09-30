import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { D1Store } from "../src/store/d1Store.ts";

const MIGRATIONS_DIR = join(__dirname, "../migrations");

/** Split each migration into single statements — D1 exec is picky about
 *  comments/multi-line dumps; wrangler's migrator tolerates them. */
export async function applyMigrations(db: D1Database, dir = MIGRATIONS_DIR): Promise<void> {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(dir, file), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    for (const stmt of sql.split(";")) {
      const trimmed = stmt.trim();
      if (trimmed) await db.prepare(trimmed).run();
    }
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

  it("dedupes unnumbered same-name rows when the INSERT races the index", async () => {
    const first = await store.getOrCreateCorporation({
      officialName: "株式会社中村商会",
      verificationStatus: "unverified",
    });
    expect(first.deduplicated).toBe(false);
    // Simulate the race: this request's read missed the row a concurrent
    // confirmation already committed, so its INSERT hits the unique index.
    const raceable = store as unknown as {
      sameNameCorporations: () => Promise<unknown[]>;
    };
    const original = raceable.sameNameCorporations;
    raceable.sameNameCorporations = async () => [];
    const second = await store.getOrCreateCorporation({
      officialName: "株式会社中村商会",
      verificationStatus: "unverified",
    });
    raceable.sameNameCorporations = original;
    expect(second.deduplicated).toBe(true);
    expect(second.corporationId).toBe(first.corporationId);
    const count = await db
      .prepare("SELECT COUNT(*) AS n FROM corporations WHERE official_name = ?")
      .bind("株式会社中村商会")
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
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

  it("does not overwrite a number claimed by a concurrent verified confirm", async () => {
    const corp = await store.getOrCreateCorporation({
      officialName: "株式会社斎藤食品",
      verificationStatus: "unverified",
    });
    // Concurrent winner: another request already numbered the same row.
    await db
      .prepare(
        "UPDATE corporations SET corporate_number = ?, verification_status = 'verified' WHERE corporation_id = ?",
      )
      .bind("4444444444444", corp.corporationId)
      .run();
    // This request still holds the stale unnumbered view it read earlier.
    const raceable = store as unknown as {
      sameNameCorporations: (n: string) => Promise<unknown[]>;
    };
    const original = raceable.sameNameCorporations;
    raceable.sameNameCorporations = async () => [
      {
        corporation_id: corp.corporationId,
        corporate_number: "",
        official_name: "株式会社斎藤食品",
        name_key: "",
        address: "",
        website: "",
        verification_status: "unverified",
      },
    ];
    const loser = await store.getOrCreateCorporation({
      officialName: "株式会社斎藤食品",
      corporateNumber: "5555555555555",
      verificationStatus: "verified",
    });
    raceable.sameNameCorporations = original;
    // Different registered numbers are distinct entities — a new row, not an alias.
    expect(loser.deduplicated).toBe(false);
    expect(loser.corporationId).not.toBe(corp.corporationId);
    const winner = await store.findCorporationByNumber("4444444444444");
    expect(winner?.corporate_number).toBe("4444444444444");
    const created = await store.findCorporationByNumber("5555555555555");
    expect(created?.official_name).toBe("株式会社斎藤食品");
  });

  it("dedupes when the concurrent winner registered the same number", async () => {
    const corp = await store.getOrCreateCorporation({
      officialName: "株式会社加藤電機",
      verificationStatus: "unverified",
    });
    await db
      .prepare(
        "UPDATE corporations SET corporate_number = ?, verification_status = 'verified' WHERE corporation_id = ?",
      )
      .bind("6666666666666", corp.corporationId)
      .run();
    const raceable = store as unknown as {
      sameNameCorporations: (n: string) => Promise<unknown[]>;
    };
    const original = raceable.sameNameCorporations;
    raceable.sameNameCorporations = async () => [
      {
        corporation_id: corp.corporationId,
        corporate_number: "",
        official_name: "株式会社加藤電機",
        name_key: "",
        address: "",
        website: "",
        verification_status: "unverified",
      },
    ];
    const loser = await store.getOrCreateCorporation({
      officialName: "株式会社加藤電機",
      corporateNumber: "6666666666666",
      verificationStatus: "verified",
    });
    raceable.sameNameCorporations = original;
    expect(loser.deduplicated).toBe(true);
    expect(loser.corporationId).toBe(corp.corporationId);
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

  it("returns same-day interactions newest-first", async () => {
    const corp = await store.getOrCreateCorporation({
      officialName: "株式会社松本印刷",
      verificationStatus: "unverified",
    });
    const person = await store.getOrCreateContact({
      corporationId: corp.corporationId,
      name: "松本 次郎",
      email: "jiro@matsumoto.example",
    });
    // interaction_at is a date-only value (YYYY-MM-DD): two meetings on the
    // same day must order by insertion recency, not insertion order-by-luck.
    await store.createInteraction({
      corporationId: corp.corporationId,
      personId: person.personId,
      interactionType: "meeting",
      interactionAt: "2026-10-01",
      summary: "初回挨拶",
      nextAction: "",
    });
    await store.createInteraction({
      corporationId: corp.corporationId,
      personId: person.personId,
      interactionType: "meeting",
      interactionAt: "2026-10-01",
      summary: "再訪",
      nextAction: "",
    });
    const interactions = await store.listInteractions({ personId: person.personId });
    expect(interactions[0]?.summary).toBe("再訪");
    expect(interactions[1]?.summary).toBe("初回挨拶");
  });

  it("dedupes contacts when a concurrent confirm wins the claims race", async () => {
    const corp = await store.getOrCreateCorporation({
      officialName: "株式会社斎藤印刷",
      verificationStatus: "unverified",
    });
    const first = await store.getOrCreateContact({
      corporationId: corp.corporationId,
      name: "斎藤 花子",
      email: "hanako@saito.example",
    });
    // Simulate a second request whose SELECT ran before the winner committed:
    // it sees no same-name rows, so it proceeds to the INSERT — where the
    // contact_claims primary key must stop the duplicate.
    let missed = false;
    const stale = new Proxy(db, {
      get(target, prop, recv) {
        if (prop !== "prepare") return Reflect.get(target, prop, recv);
        return (sql: string) => {
          const stmt = target.prepare(sql);
          if (!missed && sql.includes("FROM contacts")) {
            missed = true;
            const wrapped = Object.create(stmt) as D1PreparedStatement;
            wrapped.all = <T = Record<string, unknown>>() =>
              Promise.resolve({
                results: [] as T[],
                success: true,
                meta: {},
              } as unknown as D1Result<T>);
            return wrapped;
          }
          return stmt;
        };
      },
    });
    const loser = await new D1Store(stale as D1Database).getOrCreateContact({
      corporationId: corp.corporationId,
      name: "斎藤 花子",
      email: "hanako@saito.example",
    });
    expect(loser.deduplicated).toBe(true);
    expect(loser.personId).toBe(first.personId);
    const count = await db
      .prepare("SELECT COUNT(*) AS n FROM contacts WHERE corporation_id = ?")
      .bind(corp.corporationId)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("searches contacts by person and company keys", async () => {
    const byPerson = await store.searchContacts({ personName: "花子" });
    expect(byPerson.some((c) => c.name.includes("伊藤"))).toBe(true);
    const byCompany = await store.searchContacts({ companyNameKey: "伊藤設計" });
    expect(byCompany.some((c) => c.name.includes("伊藤"))).toBe(true);
  });
});
