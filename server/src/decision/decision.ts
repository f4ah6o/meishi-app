import type {
  ContactCandidate,
  CorporationCandidate,
  DecisionResult,
  NormalizedCard,
} from "@meishi/shared";
import { companyNameKey } from "../normalize/normalize.ts";

export interface DecisionInput {
  card: NormalizedCard;
  existingContacts: ContactCandidate[];
  corporateCandidates: CorporationCandidate[];
}

/**
 * Decision AI boundary: only narrow judgement questions (candidate choice /
 * none + confidence), never free-form generation.
 */
export interface DecisionProvider {
  decide(input: DecisionInput): Promise<DecisionResult>;
}

export const AUTO_CONFIRM_CONFIDENCE = 0.97;
export const AUTO_CONFIRM_MARGIN = 0.15;

/** Dice coefficient over character bigrams — good enough for 表記揺れ. */
export function nameSimilarity(a: string, b: string): number {
  const ka = companyNameKey(a);
  const kb = companyNameKey(b);
  if (!ka || !kb) return 0;
  if (ka === kb) return 1;
  if (ka.includes(kb) || kb.includes(ka)) {
    return Math.min(ka.length, kb.length) / Math.max(ka.length, kb.length) + 0.05;
  }
  const grams = (s: string) => {
    const set = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      set.set(g, (set.get(g) ?? 0) + 1);
    }
    return set;
  };
  const ga = grams(ka);
  const gb = grams(kb);
  let overlap = 0;
  for (const [g, n] of ga) overlap += Math.min(n, gb.get(g) ?? 0);
  return (2 * overlap) / (ka.length - 1 + (kb.length - 1));
}

function domainMatch(a: string | null, b?: string): number {
  if (!a || !b) return 0;
  try {
    const host = new URL(b.startsWith("http") ? b : `https://${b}`).hostname.replace(/^www\./, "");
    return host === a ? 1 : host.endsWith(`.${a}`) || a.endsWith(`.${host}`) ? 0.6 : 0;
  } catch {
    return 0;
  }
}

function addressSimilarity(card: NormalizedCard, candidate: CorporationCandidate): number {
  const full = `${candidate.prefecture ?? ""}${candidate.city ?? ""}${candidate.address ?? ""}`;
  if (!full) return 0;
  const addr = card.address.replace(/\s/g, "");
  if (!addr) return 0;
  let hits = 0;
  let parts = 0;
  for (const piece of [candidate.prefecture, candidate.city]) {
    if (piece && piece.length >= 2) {
      parts += 1;
      if (addr.includes(piece)) hits += 1;
    }
  }
  return parts === 0 ? 0 : hits / parts;
}

/**
 * Default deterministic scorer. It deliberately refuses to auto-confirm when
 * candidates are close or evidence is thin — the human confirms ambiguous cases.
 */
export class RuleDecisionProvider implements DecisionProvider {
  constructor(
    private readonly autoConfirmConfidence = AUTO_CONFIRM_CONFIDENCE,
    private readonly autoConfirmMargin = AUTO_CONFIRM_MARGIN,
  ) {}

  async decide(input: DecisionInput): Promise<DecisionResult> {
    const scored = input.corporateCandidates.map((c) => {
      const name = nameSimilarity(input.card.company_name, c.official_name);
      const domain = domainMatch(input.card.domain, c.website);
      const addr = addressSimilarity(input.card, c);
      // Corporate-number presence already implied by candidate source.
      const score = 0.72 * name + 0.18 * domain + 0.1 * addr;
      return { key: c.corporate_number, score, name, domain, addr };
    });
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    const second = scored[1];
    if (!best || best.name < 0.3) {
      return { choice: "none", confidence: best ? 1 - best.score : 0.9 };
    }
    const margin = second ? best.score - second.score : best.score;
    return {
      choice: best.key,
      confidence: Math.min(1, best.score),
      rationale:
        margin < this.autoConfirmMargin
          ? `close second candidate (margin ${margin.toFixed(2)})`
          : undefined,
    };
  }

  /** Whether the decision is safe to auto-confirm without human review. */
  isAutoConfirmable(result: DecisionResult, input: DecisionInput): boolean {
    if (result.choice === "none") return false;
    if (result.confidence < this.autoConfirmConfidence) return false;
    if (input.card.uncertain_fields.length > 0) return false;
    if (input.corporateCandidates.length > 1) return false;
    return true;
  }
}

/**
 * Optional Decision AI (e.g. Jev) adapter. Sends a narrow, structured decision
 * problem to an HTTP endpoint; expected response: {"choice": "...", "confidence": 0-1}.
 * Configured via JEV_ENDPOINT / JEV_API_KEY. The endpoint contract is small so
 * any choice-model service can sit behind it.
 */
export class JevDecisionProvider implements DecisionProvider {
  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly fallback: RuleDecisionProvider = new RuleDecisionProvider(),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async decide(input: DecisionInput): Promise<DecisionResult> {
    if (!this.endpoint) return this.fallback.decide(input);
    try {
      const res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          task: "select_corporation_candidate",
          card: {
            company_name: input.card.company_name,
            address: input.card.address,
            domain: input.card.domain,
          },
          candidates: input.corporateCandidates.map((c) => ({
            corporate_number: c.corporate_number,
            official_name: c.official_name,
            prefecture: c.prefecture,
            city: c.city,
            website: c.website,
          })),
          existing_contacts: input.existingContacts,
          output: { type: "choice+confidence", allow_none: true },
        }),
      });
      if (!res.ok) throw new Error(`Jev endpoint ${res.status}`);
      const body = (await res.json()) as { choice?: string; confidence?: number };
      if (typeof body.choice === "string" && typeof body.confidence === "number") {
        return { choice: body.choice, confidence: Math.max(0, Math.min(1, body.confidence)) };
      }
      return this.fallback.decide(input);
    } catch {
      // Safety: fall back to deterministic rules rather than failing closed-open.
      return this.fallback.decide(input);
    }
  }
}
