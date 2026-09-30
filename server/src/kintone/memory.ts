import type { ContactCandidate, CorporationCandidate, InteractionRecord } from "@meishi/shared";
import { companyNameKey } from "../normalize/normalize.ts";
import type { DataStore } from "./store.ts";

interface CorporationRow {
  corporation_id: string;
  corporate_number: string;
  official_name: string;
  address: string;
  website: string;
  verification_status: string;
}

interface ContactRow {
  person_id: string;
  corporation_id: string;
  name: string;
  department: string;
  title: string;
  email: string;
  phone: string;
  mobile: string;
}

interface CardRow {
  business_card_id: string;
  person_id: string;
  corporation_id: string;
  captured_at: string;
}

interface InteractionRow {
  interaction_id: string;
  corporation_id: string;
  person_id: string;
  interaction_type: string;
  interaction_at: string;
  summary: string;
  next_action: string;
}

/**
 * In-memory DataStore used for local dev without kintone (STORE_BACKEND=memory)
 * and for tests. Same dedupe semantics as the kintone implementation.
 */
export class MemoryStore implements DataStore {
  corporations = new Map<string, CorporationRow>();
  contacts = new Map<string, ContactRow>();
  cards = new Map<string, CardRow>();
  interactions = new Map<string, InteractionRow>();
  private seq = 0;

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}_${this.seq}`;
  }

  async searchCorporationsByName(nameKey: string): Promise<CorporationCandidate[]> {
    return [...this.corporations.values()]
      .filter((c) => companyNameKey(c.official_name).includes(nameKey))
      .map((c) => this.toCandidate(c));
  }

  async findCorporationByNumber(corporateNumber: string): Promise<CorporationCandidate | null> {
    const found = [...this.corporations.values()].find(
      (c) => c.corporate_number === corporateNumber,
    );
    return found ? this.toCandidate(found) : null;
  }

  async searchContacts(query: {
    companyNameKey?: string;
    personName?: string;
  }): Promise<ContactCandidate[]> {
    const normalizePerson = (s: string) => s.replace(/[\s　]+/g, "");
    const personKey = query.personName ? normalizePerson(query.personName) : null;
    return [...this.contacts.values()]
      .filter((ct) => {
        if (personKey && !normalizePerson(ct.name).includes(personKey)) return false;
        if (query.companyNameKey) {
          const corp = this.corporations.get(ct.corporation_id);
          if (!corp || !companyNameKey(corp.official_name).includes(query.companyNameKey)) {
            return false;
          }
        }
        return true;
      })
      .map((ct) => this.toContactCandidate(ct));
  }

  async listRecentContacts(limit: number): Promise<ContactCandidate[]> {
    const lastSeen = new Map<string, string>();
    for (const i of this.interactions.values()) {
      const prev = lastSeen.get(i.person_id);
      if (!prev || i.interaction_at > prev) lastSeen.set(i.person_id, i.interaction_at);
    }
    return [...this.contacts.values()]
      .map((ct) => ({
        ...this.toContactCandidate(ct),
        last_interaction_at: lastSeen.get(ct.person_id),
      }))
      .sort((a, b) => (b.last_interaction_at ?? "").localeCompare(a.last_interaction_at ?? ""))
      .slice(0, limit);
  }

  async listInteractions(filter: {
    personId?: string;
    corporationId?: string;
  }): Promise<InteractionRecord[]> {
    return [...this.interactions.values()]
      .filter(
        (i) =>
          (!filter.personId || i.person_id === filter.personId) &&
          (!filter.corporationId || i.corporation_id === filter.corporationId),
      )
      .sort((a, b) => b.interaction_at.localeCompare(a.interaction_at))
      .map((i) => ({
        interaction_id: i.interaction_id,
        interaction_type: i.interaction_type,
        interaction_at: i.interaction_at,
        summary: i.summary,
        next_action: i.next_action,
      }));
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
      const byNumber = [...this.corporations.values()].find(
        (c) => c.corporate_number === data.corporateNumber,
      );
      if (byNumber) return { corporationId: byNumber.corporation_id, deduplicated: true };
    }
    const byName = [...this.corporations.values()].find(
      (c) => companyNameKey(c.official_name) === companyNameKey(data.officialName),
    );
    if (byName) return { corporationId: byName.corporation_id, deduplicated: true };

    const corporationId = this.nextId("corp");
    this.corporations.set(corporationId, {
      corporation_id: corporationId,
      corporate_number: data.corporateNumber ?? "",
      official_name: data.officialName,
      address: data.address ?? "",
      website: data.website ?? "",
      verification_status: data.verificationStatus,
    });
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
    const norm = (s: string) => s.replace(/[\s　]+/g, "");
    const existing = [...this.contacts.values()].find(
      (ct) => ct.corporation_id === data.corporationId && norm(ct.name) === norm(data.name),
    );
    if (existing) return { personId: existing.person_id, deduplicated: true };
    const personId = this.nextId("person");
    this.contacts.set(personId, {
      person_id: personId,
      corporation_id: data.corporationId,
      name: data.name,
      department: data.department ?? "",
      title: data.title ?? "",
      email: data.email ?? "",
      phone: data.phone ?? "",
      mobile: data.mobile ?? "",
    });
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
    const id = this.nextId("card");
    this.cards.set(id, {
      business_card_id: id,
      person_id: data.personId,
      corporation_id: data.corporationId,
      captured_at: new Date().toISOString(),
    });
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
    const id = this.nextId("int");
    this.interactions.set(id, {
      interaction_id: id,
      corporation_id: data.corporationId,
      person_id: data.personId,
      interaction_type: data.interactionType,
      interaction_at: data.interactionAt,
      summary: data.summary,
      next_action: data.nextAction,
    });
    return { interactionId: id };
  }

  async getContact(personId: string): Promise<ContactCandidate | null> {
    const ct = this.contacts.get(personId);
    return ct ? this.toContactCandidate(ct) : null;
  }

  private toCandidate(c: CorporationRow): CorporationCandidate {
    return {
      source: "kintone",
      corporate_number: c.corporate_number,
      official_name: c.official_name,
      address: c.address,
      website: c.website,
    };
  }

  private toContactCandidate(ct: ContactRow): ContactCandidate {
    const corp = this.corporations.get(ct.corporation_id);
    const last = [...this.interactions.values()]
      .filter((i) => i.person_id === ct.person_id)
      .map((i) => i.interaction_at)
      .sort()
      .at(-1);
    return {
      person_id: ct.person_id,
      corporation_id: ct.corporation_id,
      corporate_number: corp?.corporate_number,
      name: ct.name,
      department: ct.department,
      title: ct.title,
      official_name: corp?.official_name,
      last_interaction_at: last,
    };
  }
}
