/** Raw structured extraction produced by the AI card extractor. */
export interface BusinessCardExtraction {
  company_name_raw: string;
  person_name: string;
  department: string;
  title: string;
  postal_code: string;
  address: string;
  phone: string;
  mobile: string;
  fax: string;
  email: string;
  website: string;
  /** Field names the extractor was unsure about — never auto-confirmed. */
  uncertain_fields: string[];
}

/** Extraction after deterministic normalization (normal code, not AI). */
export interface NormalizedCard extends BusinessCardExtraction {
  /** Canonical company name with a legal form, e.g. 株式会社山田建設. */
  company_name: string;
  /** Legal-form-stripped lookup key used for matching, e.g. 山田建設. */
  company_name_key: string;
  /** Lowercase registrable domain derived from website/email, or null. */
  domain: string | null;
}

export interface CorporationCandidate {
  source: "nta" | "gbizinfo" | "kintone";
  corporate_number: string;
  official_name: string;
  prefecture?: string;
  city?: string;
  address?: string;
  website?: string;
  /** Present on kintone-sourced candidates; public-registry hits are authoritative by nature. */
  verification_status?: string;
}

export interface ContactCandidate {
  person_id: string;
  corporation_id: string;
  corporate_number?: string;
  name: string;
  department?: string;
  title?: string;
  official_name?: string;
  last_interaction_at?: string;
  score?: number;
  reasons?: string[];
}

export interface DecisionResult {
  /** Candidate key (e.g. corporation number or person id) or "none". */
  choice: string;
  confidence: number;
  rationale?: string;
}

export interface AnalyzeResponse {
  extraction: NormalizedCard;
  raw: BusinessCardExtraction;
  existing_contacts: ContactCandidate[];
  corporate_candidates: CorporationCandidate[];
  decision: DecisionResult;
  /** True only when the decision layer judged a single unambiguous match. */
  auto_confirmable: boolean;
}

export interface SuggestResponse {
  contacts: ContactCandidate[];
}

export interface InteractionRecord {
  interaction_id: string;
  interaction_type: string;
  interaction_at: string;
  summary: string;
  next_action: string;
}

export interface MeetingContext {
  contact: ContactCandidate;
  recent_interactions: InteractionRecord[];
}

export interface ConfirmedCardData {
  company_name: string;
  official_name?: string;
  corporate_number?: string;
  corporation_id?: string;
  /** Explicit user-chosen existing contact — the only id-based merge allowed. */
  person_id?: string;
  person_name: string;
  department?: string;
  title?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  postal_code?: string;
  address?: string;
  website?: string;
  /** Raw extractor output, kept on the business-card record for audit. */
  raw_extraction?: string;
  decision_confidence?: number;
  meeting?: {
    interaction_type: string;
    interaction_at: string;
    summary: string;
    next_action: string;
  };
}

export interface ConfirmResponse {
  corporation_id: string;
  person_id: string;
  business_card_id: string;
  interaction_id?: string;
  /** True when an existing corporation record was reused instead of creating one. */
  deduplicated: boolean;
  /** True when the corporate_number was verified against kintone or a public registry. */
  corporation_verified?: boolean;
}

export interface ApiError {
  error: string;
  message?: string;
}
