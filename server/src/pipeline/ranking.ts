import type { ContactCandidate } from "@meishi/shared";

/**
 * Rule-based repeat-meeting ranking. No vector DB required for the PoC.
 * Score elements (from the spec): recency, frequency, same corporation,
 * recent interactions, partial name match.
 */
export interface RankingSignal {
  /** Partially recognized company name key (normalized, legal-form stripped). */
  companyNameKey?: string;
  /** Partially recognized person name (whitespace-stripped). */
  personName?: string;
  /** Scheduled meeting attendee hints for this occasion (person ids). */
  scheduledPersonIds?: string[];
  /** Number of past interactions per person. */
  interactionCounts?: Map<string, number>;
  now?: Date;
}

export function rankContacts(
  contacts: ContactCandidate[],
  signal: RankingSignal,
): ContactCandidate[] {
  const now = signal.now?.getTime() ?? Date.now();
  const day = 86_400_000;
  const normPerson = (s?: string) => (s ?? "").replace(/[\s　]+/g, "");

  const scored = contacts.map((ct) => {
    let score = 0;
    const reasons: string[] = [];

    // Recency of last interaction: half-life ~30 days.
    if (ct.last_interaction_at) {
      const age = Math.max(0, now - Date.parse(ct.last_interaction_at)) / day;
      const recency = Math.exp(-age / 30);
      score += 3 * recency;
      reasons.push(`最近接触 (${ct.last_interaction_at.slice(0, 10)})`);
    }

    // Frequency.
    const count = signal.interactionCounts?.get(ct.person_id) ?? 0;
    if (count > 0) {
      score += Math.min(2, 0.4 * count);
      reasons.push(`商談${count}回`);
    }

    // Partial company-name match.
    if (signal.companyNameKey && ct.official_name) {
      const key = signal.companyNameKey;
      const corpKey = ct.official_name.replace(
        /株式会社|有限会社|合同会社|合資会社|合名会社|（株）|\(株\)|㈱|（有）|\(有\)|㈳|（同）|\(同\)|（資）|\(資\)|（名）|\(名\)/g,
        "",
      );
      if (corpKey.includes(key) || key.includes(corpKey)) {
        score += 2.5;
        reasons.push("会社名一致");
      }
    }

    // Partial person-name match.
    const wanted = normPerson(signal.personName);
    if (wanted && normPerson(ct.name).includes(wanted)) {
      score += 2.5;
      reasons.push("氏名一致");
    }

    // Scheduled-attendee hint.
    if (signal.scheduledPersonIds?.includes(ct.person_id)) {
      score += 3;
      reasons.push("今回の予定と一致");
    }

    return { ...ct, score, reasons };
  });

  return scored.filter((ct) => (ct.score ?? 0) > 0).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}
