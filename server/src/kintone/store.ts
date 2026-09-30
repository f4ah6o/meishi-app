import type { ContactCandidate, CorporationCandidate, InteractionRecord } from "@meishi/shared";

/**
 * Data store boundary over kintone. `corporate_number` is the primary identity
 * key for corporations; `getOrCreateCorporation` enforces dedupe on it.
 */
export interface DataStore {
  searchCorporationsByName(nameKey: string): Promise<CorporationCandidate[]>;
  findCorporationByNumber(corporateNumber: string): Promise<CorporationCandidate | null>;
  searchContacts(query: {
    companyNameKey?: string;
    personName?: string;
  }): Promise<ContactCandidate[]>;
  listRecentContacts(limit: number): Promise<ContactCandidate[]>;
  listInteractions(filter: {
    personId?: string;
    corporationId?: string;
  }): Promise<InteractionRecord[]>;
  getOrCreateCorporation(data: {
    officialName: string;
    corporateNumber?: string;
    address?: string;
    website?: string;
    verificationStatus: string;
  }): Promise<{ corporationId: string; deduplicated: boolean }>;
  getOrCreateContact(data: {
    corporationId: string;
    name: string;
    department?: string;
    title?: string;
    email?: string;
    phone?: string;
    mobile?: string;
  }): Promise<{ personId: string; deduplicated: boolean }>;
  createBusinessCard(data: {
    personId: string;
    corporationId: string;
    imageReference: string;
    rawExtraction: string;
    confirmedData: string;
    decisionConfidence: number;
    reviewStatus: string;
  }): Promise<{ businessCardId: string }>;
  createInteraction(data: {
    corporationId: string;
    personId: string;
    interactionType: string;
    interactionAt: string;
    summary: string;
    nextAction: string;
  }): Promise<{ interactionId: string }>;
  getContact(personId: string): Promise<ContactCandidate | null>;
}
