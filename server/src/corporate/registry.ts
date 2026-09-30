import type { CorporationCandidate } from "@meishi/shared";

export interface CorporateSearchQuery {
  /** Legal-form-stripped company name key. */
  name: string;
  prefecture?: string;
  city?: string;
  domain?: string | null;
}

/** Public corporate registry boundary (国税庁法人番号API / gBizINFO). */
export interface CorporateRegistry {
  search(query: CorporateSearchQuery): Promise<CorporationCandidate[]>;
  /**
   * Resolve a 13-digit corporate number to a corporation. Absent when the
   * registry cannot verify numbers — callers must treat that as unverifiable.
   */
  findByNumber?(corporateNumber: string): Promise<CorporationCandidate | null>;
}

/** No-op registry used when no credentials are configured. */
export class NullRegistry implements CorporateRegistry {
  async search(): Promise<CorporationCandidate[]> {
    return [];
  }
}
