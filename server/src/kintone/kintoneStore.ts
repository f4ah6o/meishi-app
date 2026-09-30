import type { ContactCandidate, CorporationCandidate, InteractionRecord } from "@meishi/shared";
import type { AppConfig } from "../config.ts";
import { field, type KintoneClient, q, recordId } from "./client.ts";
import type { DataStore } from "./store.ts";

const V = (value: unknown) => ({ value });

/**
 * DataStore backed by kintone apps. Expected field codes (see README):
 *   corporations:  corporate_number, official_name, address, website, verification_status
 *   contacts:      corporation_id, name, department, title, email, phone, mobile
 *   businessCards: person_id, corporation_id, image_reference, captured_at,
 *                  raw_extraction, confirmed_data, decision_confidence, review_status
 *   interactions:  corporation_id, person_id, interaction_type, interaction_at,
 *                  summary, next_action
 */
export class KintoneStore implements DataStore {
  constructor(
    private readonly client: KintoneClient,
    private readonly config: AppConfig,
  ) {}

  private get apps() {
    return this.config.kintoneApps;
  }

  async searchCorporationsByName(nameKey: string): Promise<CorporationCandidate[]> {
    const records = await this.client.getRecords(
      this.apps.corporations.appId,
      this.apps.corporations.token,
      `official_name like "${q(nameKey)}" order by $id desc limit 20`,
    );
    return records.map((r) => ({
      source: "kintone",
      corporate_number: field(r, "corporate_number"),
      official_name: field(r, "official_name"),
      address: field(r, "address"),
      website: field(r, "website"),
    }));
  }

  async findCorporationByNumber(corporateNumber: string): Promise<CorporationCandidate | null> {
    const records = await this.client.getRecords(
      this.apps.corporations.appId,
      this.apps.corporations.token,
      `corporate_number = "${q(corporateNumber)}" limit 1`,
    );
    const r = records[0];
    if (!r) return null;
    return {
      source: "kintone",
      corporate_number: field(r, "corporate_number"),
      official_name: field(r, "official_name"),
      address: field(r, "address"),
      website: field(r, "website"),
    };
  }

  async searchContacts(query: {
    companyNameKey?: string;
    personName?: string;
  }): Promise<ContactCandidate[]> {
    const conditions: string[] = [];
    if (query.personName) conditions.push(`name like "${q(query.personName)}"`);
    const personClause = conditions.length ? conditions.join(" and ") : "";
    let contacts = await this.client.getRecords(
      this.apps.contacts.appId,
      this.apps.contacts.token,
      `${personClause ? `${personClause} ` : ""}order by $id desc limit 20`,
    );
    if (query.companyNameKey) {
      const corpIds = await this.corporationIdsForName(query.companyNameKey);
      contacts = contacts.filter((ct) => corpIds.has(field(ct, "corporation_id")));
    }
    return Promise.all(contacts.map((r) => this.toContactCandidate(r)));
  }

  private async corporationIdsForName(nameKey: string): Promise<Set<string>> {
    const records = await this.client.getRecords(
      this.apps.corporations.appId,
      this.apps.corporations.token,
      `official_name like "${q(nameKey)}" limit 50`,
      ["$id"],
    );
    return new Set(records.map(recordId));
  }

  async listRecentContacts(limit: number): Promise<ContactCandidate[]> {
    // Fetch recent interactions, then hydrate their contacts.
    const interactions = await this.client.getRecords(
      this.apps.interactions.appId,
      this.apps.interactions.token,
      `order by interaction_at desc limit ${Math.max(limit, 20)}`,
    );
    const lastSeen = new Map<string, string>();
    for (const r of interactions) {
      const pid = field(r, "person_id");
      if (!lastSeen.has(pid)) lastSeen.set(pid, field(r, "interaction_at"));
    }
    const out: ContactCandidate[] = [];
    for (const [pid, at] of lastSeen) {
      const contact = await this.getContact(pid);
      if (contact) out.push({ ...contact, last_interaction_at: at });
      if (out.length >= limit) break;
    }
    return out;
  }

  async listInteractions(filter: {
    personId?: string;
    corporationId?: string;
  }): Promise<InteractionRecord[]> {
    const conds: string[] = [];
    if (filter.personId) conds.push(`person_id = "${q(filter.personId)}"`);
    if (filter.corporationId) conds.push(`corporation_id = "${q(filter.corporationId)}"`);
    const query = `${conds.join(" and ")}${conds.length ? " " : ""}order by interaction_at desc limit 10`;
    const records = await this.client.getRecords(
      this.apps.interactions.appId,
      this.apps.interactions.token,
      query,
    );
    return records.map((r) => ({
      interaction_id: recordId(r),
      interaction_type: field(r, "interaction_type"),
      interaction_at: field(r, "interaction_at"),
      summary: field(r, "summary"),
      next_action: field(r, "next_action"),
    }));
  }

  async getOrCreateCorporation(data: {
    officialName: string;
    corporateNumber?: string;
    address?: string;
    website?: string;
    verificationStatus: string;
  }): Promise<{ corporationId: string; deduplicated: boolean }> {
    if (data.corporateNumber) {
      const existing = await this.client.getRecords(
        this.apps.corporations.appId,
        this.apps.corporations.token,
        `corporate_number = "${q(data.corporateNumber)}" limit 1`,
      );
      if (existing[0]) return { corporationId: recordId(existing[0]), deduplicated: true };
    }
    const byName = await this.client.getRecords(
      this.apps.corporations.appId,
      this.apps.corporations.token,
      `official_name = "${q(data.officialName)}" limit 10`,
    );
    if (!data.corporateNumber) {
      // An explicit "no corporate number" choice must not be overridden by a
      // same-name record that does carry a number — only unnumbered records
      // are safe to dedupe against without number-selected evidence.
      const named = byName.find((r) => field(r, "corporate_number") === "");
      if (named) return { corporationId: recordId(named), deduplicated: true };
    } else {
      // A same-name record holding a different corporate_number is a distinct
      // legal entity — never alias it; create a new record.
      const conflict = byName.some((r) => {
        const n = field(r, "corporate_number");
        return n !== "" && n !== data.corporateNumber;
      });
      const unnumbered = byName.find((r) => field(r, "corporate_number") === "");
      // Only a verified number upgrades an unnumbered same-name record via a
      // real kintone update; an unverifiable number is never attached to it.
      if (!conflict && unnumbered && data.verificationStatus === "verified") {
        const patch: Record<string, { value: unknown }> = {
          corporate_number: V(data.corporateNumber),
          verification_status: V("verified"),
        };
        if (data.address && !field(unnumbered, "address")) patch.address = V(data.address);
        if (data.website && !field(unnumbered, "website")) patch.website = V(data.website);
        await this.client.putRecord(
          this.apps.corporations.appId,
          this.apps.corporations.token,
          recordId(unnumbered),
          patch,
        );
        return { corporationId: recordId(unnumbered), deduplicated: true };
      }
    }

    const created = await this.client.postRecord(
      this.apps.corporations.appId,
      this.apps.corporations.token,
      {
        corporate_number: V(data.corporateNumber ?? ""),
        official_name: V(data.officialName),
        address: V(data.address ?? ""),
        website: V(data.website ?? ""),
        verification_status: V(data.verificationStatus),
      },
    );
    return { corporationId: created.id, deduplicated: false };
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
    const norm = (s: string) => s.replace(/[\s　]+/g, "");
    const digits = (s: string) => s.replace(/\D/g, "");
    const existing = await this.client.getRecords(
      this.apps.contacts.appId,
      this.apps.contacts.token,
      `corporation_id = "${q(data.corporationId)}" limit 50`,
    );
    // Name alone is a weak key: a same-name contact whose nonempty
    // email/phone/mobile differs is a different person — never merge.
    const identifierConflict = (r: Record<string, { value: unknown }>) =>
      (data.email &&
        field(r, "email") &&
        field(r, "email").toLowerCase() !== data.email.toLowerCase()) ||
      (data.phone && field(r, "phone") && digits(field(r, "phone")) !== digits(data.phone)) ||
      (data.mobile && field(r, "mobile") && digits(field(r, "mobile")) !== digits(data.mobile));
    const dup = existing.find(
      (r) => norm(field(r, "name")) === norm(data.name) && !identifierConflict(r),
    );
    if (dup) {
      // Backfill identifiers the stored record is missing.
      const patch: Record<string, { value: unknown }> = {};
      for (const key of ["email", "phone", "mobile", "department", "title"] as const) {
        const v = data[key];
        if (v && !field(dup, key)) patch[key] = V(v);
      }
      if (Object.keys(patch).length > 0) {
        await this.client.putRecord(
          this.apps.contacts.appId,
          this.apps.contacts.token,
          recordId(dup),
          patch,
        );
      }
      return { personId: recordId(dup), deduplicated: true };
    }

    const created = await this.client.postRecord(
      this.apps.contacts.appId,
      this.apps.contacts.token,
      {
        corporation_id: V(data.corporationId),
        name: V(data.name),
        department: V(data.department ?? ""),
        title: V(data.title ?? ""),
        email: V(data.email ?? ""),
        phone: V(data.phone ?? ""),
        mobile: V(data.mobile ?? ""),
      },
    );
    return { personId: created.id, deduplicated: false };
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
    const created = await this.client.postRecord(
      this.apps.businessCards.appId,
      this.apps.businessCards.token,
      {
        person_id: V(data.personId),
        corporation_id: V(data.corporationId),
        image_reference: V(data.imageReference),
        captured_at: V(new Date().toISOString()),
        raw_extraction: V(data.rawExtraction),
        confirmed_data: V(data.confirmedData),
        decision_confidence: V(String(data.decisionConfidence)),
        review_status: V(data.reviewStatus),
      },
    );
    return { businessCardId: created.id };
  }

  async createInteraction(data: {
    corporationId: string;
    personId: string;
    interactionType: string;
    interactionAt: string;
    summary: string;
    nextAction: string;
  }): Promise<{ interactionId: string }> {
    const created = await this.client.postRecord(
      this.apps.interactions.appId,
      this.apps.interactions.token,
      {
        corporation_id: V(data.corporationId),
        person_id: V(data.personId),
        interaction_type: V(data.interactionType),
        interaction_at: V(data.interactionAt),
        summary: V(data.summary),
        next_action: V(data.nextAction),
      },
    );
    return { interactionId: created.id };
  }

  async getContact(personId: string): Promise<ContactCandidate | null> {
    const records = await this.client.getRecords(
      this.apps.contacts.appId,
      this.apps.contacts.token,
      `$id = "${q(personId)}" limit 1`,
    );
    const r = records[0];
    return r ? this.toContactCandidate(r) : null;
  }

  private async toContactCandidate(
    r: Record<string, { value: unknown }>,
  ): Promise<ContactCandidate> {
    const corpId = field(r as never, "corporation_id");
    let corp: CorporationCandidate | null = null;
    if (corpId) {
      const corps = await this.client.getRecords(
        this.apps.corporations.appId,
        this.apps.corporations.token,
        `$id = "${q(corpId)}" limit 1`,
      );
      const cr = corps[0];
      if (cr) {
        corp = {
          source: "kintone",
          corporate_number: field(cr, "corporate_number"),
          official_name: field(cr, "official_name"),
        };
      }
    }
    return {
      person_id: recordId(r as never),
      corporation_id: corpId,
      corporate_number: corp?.corporate_number,
      name: field(r as never, "name"),
      department: field(r as never, "department"),
      title: field(r as never, "title"),
      official_name: corp?.official_name,
    };
  }
}
