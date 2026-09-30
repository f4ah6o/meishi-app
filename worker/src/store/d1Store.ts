import type { DataStore } from "@meishi/server/src/kintone/store.ts";
import { companyNameKey } from "@meishi/server/src/normalize/normalize.ts";
import type { ContactCandidate, CorporationCandidate, InteractionRecord } from "@meishi/shared";

interface CorporationRow {
  corporation_id: string;
  corporate_number: string;
  official_name: string;
  name_key: string;
  address: string;
  website: string;
  verification_status: string;
}

interface ContactRow {
  person_id: string;
  corporation_id: string;
  name: string;
  name_key: string;
  department: string;
  title: string;
  email: string;
  phone: string;
  mobile: string;
}

const personNameKey = (s: string) => s.replace(/[\s　]+/g, "");
const digits = (s: string) => s.replace(/\D/g, "");
const newId = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;

/**
 * Durable DataStore on Cloudflare D1 (SQLite). Mirrors MemoryStore's dedupe
 * semantics: corporate_number is the primary corporation identity key, and
 * contact merges require a matching identifier with no conflicting one.
 * All queries use bound parameters.
 */
export class D1Store implements DataStore {
  constructor(private readonly db: D1Database) {}

  async searchCorporationsByName(nameKey: string): Promise<CorporationCandidate[]> {
    const { results } = await this.db
      .prepare(
        `SELECT corporation_id, corporate_number, official_name, name_key,
                address, website, verification_status
         FROM corporations WHERE name_key LIKE '%' || ? || '%'`,
      )
      .bind(nameKey)
      .all<CorporationRow>();
    return results.map((c) => this.toCandidate(c));
  }

  async findCorporationByNumber(corporateNumber: string): Promise<CorporationCandidate | null> {
    const row = await this.db
      .prepare(
        `SELECT corporation_id, corporate_number, official_name, name_key,
                address, website, verification_status
         FROM corporations WHERE corporate_number = ?`,
      )
      .bind(corporateNumber)
      .first<CorporationRow>();
    return row ? this.toCandidate(row) : null;
  }

  async searchContacts(query: {
    companyNameKey?: string;
    personName?: string;
  }): Promise<ContactCandidate[]> {
    const personKey = query.personName ? personNameKey(query.personName) : null;
    const where: string[] = [];
    const params: string[] = [];
    if (personKey) {
      where.push(`c.name_key LIKE '%' || ? || '%'`);
      params.push(personKey);
    }
    if (query.companyNameKey) {
      where.push(`corp.name_key LIKE '%' || ? || '%'`);
      params.push(query.companyNameKey);
    }
    const { results } = await this.db
      .prepare(
        `SELECT c.*, corp.corporate_number AS corp_number,
                corp.official_name AS corp_official_name,
                (SELECT MAX(i.interaction_at) FROM interactions i
                  WHERE i.person_id = c.person_id) AS last_interaction_at
         FROM contacts c JOIN corporations corp ON corp.corporation_id = c.corporation_id
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`,
      )
      .bind(...params)
      .all<
        ContactRow & {
          corp_number: string;
          corp_official_name: string;
          last_interaction_at: string | null;
        }
      >();
    return results.map((r) => this.toContactCandidate(r));
  }

  async listRecentContacts(limit: number): Promise<ContactCandidate[]> {
    const { results } = await this.db
      .prepare(
        `SELECT c.*, corp.corporate_number AS corp_number,
                corp.official_name AS corp_official_name,
                (SELECT MAX(i.interaction_at) FROM interactions i
                  WHERE i.person_id = c.person_id) AS last_interaction_at
         FROM contacts c JOIN corporations corp ON corp.corporation_id = c.corporation_id
         ORDER BY last_interaction_at DESC, c.created_at DESC
         LIMIT ?`,
      )
      .bind(limit)
      .all<
        ContactRow & {
          corp_number: string;
          corp_official_name: string;
          last_interaction_at: string | null;
        }
      >();
    return results.map((r) => this.toContactCandidate(r));
  }

  async listInteractions(filter: {
    personId?: string;
    corporationId?: string;
  }): Promise<InteractionRecord[]> {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.personId) {
      where.push("person_id = ?");
      params.push(filter.personId);
    }
    if (filter.corporationId) {
      where.push("corporation_id = ?");
      params.push(filter.corporationId);
    }
    const { results } = await this.db
      .prepare(
        `SELECT interaction_id, interaction_type, interaction_at, summary, next_action
         FROM interactions
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY interaction_at DESC, created_at DESC, rowid DESC`,
      )
      .bind(...params)
      .all<InteractionRecord>();
    return results;
  }

  async resolveCorporation(data: {
    officialName: string;
    corporateNumber?: string;
    verificationStatus: string;
  }): Promise<string | null> {
    if (data.corporateNumber) {
      const byNumber = await this.db
        .prepare("SELECT corporation_id FROM corporations WHERE corporate_number = ?")
        .bind(data.corporateNumber)
        .first<{ corporation_id: string }>();
      if (byNumber) return byNumber.corporation_id;
    }
    const sameName = await this.sameNameCorporations(data.officialName);
    if (!data.corporateNumber) {
      return sameName.find((c) => !c.corporate_number)?.corporation_id ?? null;
    }
    const conflict = sameName.some(
      (c) => c.corporate_number && c.corporate_number !== data.corporateNumber,
    );
    const unnumbered = sameName.find((c) => !c.corporate_number);
    if (!conflict && unnumbered && data.verificationStatus === "verified") {
      return unnumbered.corporation_id;
    }
    return null;
  }

  async getOrCreateCorporation(data: {
    officialName: string;
    corporateNumber?: string;
    address?: string;
    website?: string;
    verificationStatus: string;
  }): Promise<{ corporationId: string; deduplicated: boolean }> {
    // Dedupe: corporate_number is the primary identity key.
    if (data.corporateNumber) {
      const byNumber = await this.db
        .prepare(
          `SELECT corporation_id, corporate_number, official_name, name_key,
                  address, website, verification_status
           FROM corporations WHERE corporate_number = ?`,
        )
        .bind(data.corporateNumber)
        .first<CorporationRow>();
      if (byNumber) {
        // A verified identity upgrades a previously unverified record.
        if (data.verificationStatus === "verified" && byNumber.verification_status !== "verified") {
          await this.db
            .prepare(
              `UPDATE corporations
               SET verification_status = 'verified', official_name = ?, name_key = ?,
                   address = CASE WHEN address = '' THEN ? ELSE address END,
                   website = CASE WHEN website = '' THEN ? ELSE website END
               WHERE corporation_id = ?`,
            )
            .bind(
              data.officialName,
              companyNameKey(data.officialName),
              data.address ?? "",
              data.website ?? "",
              byNumber.corporation_id,
            )
            .run();
        }
        return { corporationId: byNumber.corporation_id, deduplicated: true };
      }
    }
    const sameName = await this.sameNameCorporations(data.officialName);
    if (!data.corporateNumber) {
      // An explicit "no corporate number" choice must not be overridden by a
      // same-name record that does carry a number — only unnumbered records
      // are safe to dedupe against without number-selected evidence.
      const byName = sameName.find((c) => !c.corporate_number);
      if (byName) return { corporationId: byName.corporation_id, deduplicated: true };
    } else {
      // A same-name corporation holding a different registered
      // corporate_number is a distinct legal entity — never alias it.
      const conflict = sameName.some(
        (c) => c.corporate_number && c.corporate_number !== data.corporateNumber,
      );
      const unnumbered = sameName.find((c) => !c.corporate_number);
      // Only a verified number lets us upgrade an unnumbered same-name record;
      // an unverifiable number must not be silently attached to it.
      if (!conflict && unnumbered && data.verificationStatus === "verified") {
        // Compare-and-set: the row is only claimable while still unnumbered.
        // Two verified confirms carrying *different* numbers may have read the
        // same unnumbered row; without this guard the second write would
        // overwrite the first number and both would report the same id,
        // aliasing distinct legal entities.
        const claimed = await this.db
          .prepare(
            `UPDATE corporations
             SET corporate_number = ?, verification_status = 'verified',
                 address = CASE WHEN address = '' THEN ? ELSE address END,
                 website = CASE WHEN website = '' THEN ? ELSE website END
             WHERE corporation_id = ? AND corporate_number = ''`,
          )
          .bind(
            data.corporateNumber,
            data.address ?? "",
            data.website ?? "",
            unnumbered.corporation_id,
          )
          .run();
        if (claimed.meta.changes === 1) {
          return { corporationId: unnumbered.corporation_id, deduplicated: true };
        }
        // Lost the race — re-read whoever claimed the row.
        const winner = await this.db
          .prepare(
            `SELECT corporation_id, corporate_number, official_name, name_key,
                    address, website, verification_status
             FROM corporations WHERE corporation_id = ?`,
          )
          .bind(unnumbered.corporation_id)
          .first<CorporationRow>();
        if (winner && winner.corporate_number === data.corporateNumber) {
          return { corporationId: winner.corporation_id, deduplicated: true };
        }
        // A different number claimed the row: it is a distinct legal entity,
        // so fall through to the INSERT (the corporate_number unique index
        // dedupes if this number is already registered elsewhere).
      }
    }

    const corporationId = newId("corp");
    try {
      await this.db
        .prepare(
          `INSERT INTO corporations
             (corporation_id, corporate_number, official_name, name_key,
              address, website, verification_status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          corporationId,
          data.corporateNumber ?? "",
          data.officialName,
          companyNameKey(data.officialName),
          data.address ?? "",
          data.website ?? "",
          data.verificationStatus,
          new Date().toISOString(),
        )
        .run();
    } catch (e) {
      // A concurrent confirmation may have inserted the same identity
      // (corporate_number, or name_key while still unnumbered) between our
      // read and this INSERT: the partial unique indexes stop the duplicate
      // row, and we dedupe onto the winner instead of failing with a 500.
      if (/unique|constraint/i.test(String(e))) {
        const winner = data.corporateNumber
          ? await this.db
              .prepare("SELECT corporation_id FROM corporations WHERE corporate_number = ?")
              .bind(data.corporateNumber)
              .first<{ corporation_id: string }>()
          : await this.db
              .prepare(
                "SELECT corporation_id FROM corporations WHERE corporate_number = '' AND name_key = ?",
              )
              .bind(companyNameKey(data.officialName))
              .first<{ corporation_id: string }>();
        if (winner) return { corporationId: winner.corporation_id, deduplicated: true };
      }
      throw e;
    }
    return { corporationId, deduplicated: false };
  }

  async getOrCreateContact(data: {
    corporationId: string;
    name: string;
    department?: string;
    title?: string;
    email?: string;
    phone?: string;
    mobile?: string;
  }): Promise<{ personId: string; deduplicated: boolean }> {
    // Name alone is a weak key — auto-merge requires at least one stable
    // identifier that actually matches, with no conflicting identifier.
    const identifierMatch = (ct: ContactRow) =>
      (data.email && ct.email && ct.email.toLowerCase() === data.email.toLowerCase()) ||
      (data.phone && ct.phone && digits(ct.phone) === digits(data.phone)) ||
      (data.mobile && ct.mobile && digits(ct.mobile) === digits(data.mobile));
    const identifierConflict = (ct: ContactRow) =>
      (data.email && ct.email && ct.email.toLowerCase() !== data.email.toLowerCase()) ||
      (data.phone && ct.phone && digits(ct.phone) !== digits(data.phone)) ||
      (data.mobile && ct.mobile && digits(ct.mobile) !== digits(data.mobile));
    const nameKey = personNameKey(data.name);
    const findMergeable = async () => {
      const { results } = await this.db
        .prepare(
          `SELECT person_id, corporation_id, name, name_key, department, title,
                  email, phone, mobile
           FROM contacts WHERE corporation_id = ? AND name_key = ?`,
        )
        .bind(data.corporationId, nameKey)
        .all<ContactRow>();
      return results.find((ct) => identifierMatch(ct) && !identifierConflict(ct));
    };
    const existing = await findMergeable();
    if (existing) {
      // Backfill identifiers the stored record is missing.
      const email = data.email && !existing.email ? data.email : existing.email;
      const phone = data.phone && !existing.phone ? data.phone : existing.phone;
      const mobile = data.mobile && !existing.mobile ? data.mobile : existing.mobile;
      const department =
        data.department && !existing.department ? data.department : existing.department;
      const title = data.title && !existing.title ? data.title : existing.title;
      if (
        email !== existing.email ||
        phone !== existing.phone ||
        mobile !== existing.mobile ||
        department !== existing.department ||
        title !== existing.title
      ) {
        await this.db
          .prepare(
            `UPDATE contacts SET email = ?, phone = ?, mobile = ?, department = ?, title = ?
             WHERE person_id = ?`,
          )
          .bind(email, phone, mobile, department, title, existing.person_id)
          .run();
      }
      return { personId: existing.person_id, deduplicated: true };
    }
    const personId = newId("person");
    const insertContact = () =>
      this.db
        .prepare(
          `INSERT INTO contacts
             (person_id, corporation_id, name, name_key, department, title,
              email, phone, mobile, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          personId,
          data.corporationId,
          data.name,
          nameKey,
          data.department ?? "",
          data.title ?? "",
          data.email ?? "",
          data.phone ?? "",
          data.mobile ?? "",
          new Date().toISOString(),
        );
    // Atomic claim on the canonical identity (same corporation + normalized
    // name + each supplied identifier): batched with the INSERT, so a
    // concurrent confirm that committed its claims first makes our batch
    // fail instead of inserting a duplicate.
    const claims: string[] = [];
    if (data.email) claims.push(`e|${data.email.toLowerCase()}`);
    if (data.phone) claims.push(`p|${digits(data.phone)}`);
    if (data.mobile) claims.push(`m|${digits(data.mobile)}`);
    const claimedAt = new Date().toISOString();
    const stmts = [
      ...claims.map((k) =>
        this.db
          .prepare("INSERT INTO contact_claims (claim_key, person_id, created_at) VALUES (?, ?, ?)")
          .bind(`${data.corporationId}|${nameKey}|${k}`, personId, claimedAt),
      ),
      insertContact(),
    ];
    try {
      if (stmts.length > 1) await this.db.batch(stmts);
      else await stmts[0]!.run();
    } catch (e) {
      if (/unique|constraint/i.test(String(e))) {
        // Lost the race — the winner's contact row is now committed.
        const winner = await findMergeable();
        if (winner) return { personId: winner.person_id, deduplicated: true };
        // A claim exists but no mergeable row: either an interrupted write
        // left an orphan claim, or the matching identifier belongs to a
        // record our semantics treat as a different person (conflicting
        // identifier). Create the row anyway rather than wedging on it.
        await insertContact().run();
        return { personId, deduplicated: false };
      }
      throw e;
    }
    return { personId, deduplicated: false };
  }

  async createBusinessCard(data: {
    personId: string;
    corporationId: string;
    imageReference: string;
    rawExtraction: string;
    confirmedData: string;
    decisionConfidence: number;
    reviewStatus: string;
  }): Promise<{ businessCardId: string }> {
    const id = newId("card");
    await this.db
      .prepare(
        `INSERT INTO business_cards
           (business_card_id, person_id, corporation_id, image_reference,
            captured_at, raw_extraction, confirmed_data, decision_confidence,
            review_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        data.personId,
        data.corporationId,
        data.imageReference,
        new Date().toISOString(),
        data.rawExtraction,
        data.confirmedData,
        data.decisionConfidence,
        data.reviewStatus,
      )
      .run();
    return { businessCardId: id };
  }

  async createInteraction(data: {
    corporationId: string;
    personId: string;
    interactionType: string;
    interactionAt: string;
    summary: string;
    nextAction: string;
  }): Promise<{ interactionId: string }> {
    const id = newId("int");
    await this.db
      .prepare(
        `INSERT INTO interactions
           (interaction_id, corporation_id, person_id, interaction_type,
            interaction_at, summary, next_action, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        data.corporationId,
        data.personId,
        data.interactionType,
        data.interactionAt,
        data.summary,
        data.nextAction,
        new Date().toISOString(),
      )
      .run();
    return { interactionId: id };
  }

  async getContact(personId: string): Promise<ContactCandidate | null> {
    const row = await this.db
      .prepare(
        `SELECT c.*, corp.corporate_number AS corp_number,
                corp.official_name AS corp_official_name,
                (SELECT MAX(i.interaction_at) FROM interactions i
                  WHERE i.person_id = c.person_id) AS last_interaction_at
         FROM contacts c JOIN corporations corp ON corp.corporation_id = c.corporation_id
         WHERE c.person_id = ?`,
      )
      .bind(personId)
      .first<
        ContactRow & {
          corp_number: string;
          corp_official_name: string;
          last_interaction_at: string | null;
        }
      >();
    return row ? this.toContactCandidate(row) : null;
  }

  private async sameNameCorporations(officialName: string): Promise<CorporationRow[]> {
    const { results } = await this.db
      .prepare(
        `SELECT corporation_id, corporate_number, official_name, name_key,
                address, website, verification_status
         FROM corporations WHERE name_key = ?`,
      )
      .bind(companyNameKey(officialName))
      .all<CorporationRow>();
    return results;
  }

  private toCandidate(c: CorporationRow): CorporationCandidate {
    return {
      source: "kintone",
      corporate_number: c.corporate_number,
      official_name: c.official_name,
      address: c.address,
      website: c.website,
      verification_status: c.verification_status,
    };
  }

  private toContactCandidate(
    ct: ContactRow & {
      corp_number?: string;
      corp_official_name?: string;
      last_interaction_at?: string | null;
    },
  ): ContactCandidate {
    return {
      person_id: ct.person_id,
      corporation_id: ct.corporation_id,
      corporate_number: ct.corp_number || undefined,
      name: ct.name,
      department: ct.department,
      title: ct.title,
      official_name: ct.corp_official_name || undefined,
      last_interaction_at: ct.last_interaction_at ?? undefined,
    };
  }
}
