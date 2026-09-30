import type {
  AnalyzeResponse,
  BusinessCardExtraction,
  CorporationCandidate,
  NormalizedCard,
} from "@meishi/shared";
import type { CorporateRegistry } from "../corporate/registry.ts";
import type { DecisionProvider, RuleDecisionProvider } from "../decision/decision.ts";
import type { DataStore } from "../kintone/store.ts";
import { companyNameKey } from "../normalize/normalize.ts";
import { rankContacts } from "./ranking.ts";

export interface IdentifyDeps {
  store: DataStore;
  registry: CorporateRegistry;
  decider: DecisionProvider;
  /** Present when the decider is the rule provider (auto-confirm check). */
  ruleDecider?: RuleDecisionProvider;
}

/**
 * After normalization: search kintone first, then public corporate data only
 * when kintone gives no decisive match — exactly the spec's ordering.
 */
export async function identify(
  card: NormalizedCard,
  raw: BusinessCardExtraction,
  deps: IdentifyDeps,
): Promise<AnalyzeResponse> {
  const { store, registry, decider, ruleDecider } = deps;

  const existingContacts = rankContacts(
    await store.searchContacts({
      companyNameKey: card.company_name_key || undefined,
      personName: card.person_name || undefined,
    }),
    {
      companyNameKey: card.company_name_key || undefined,
      personName: card.person_name || undefined,
    },
  );

  // kintone corporations are trusted over public registry results.
  const kintoneCorps = card.company_name_key
    ? await store.searchCorporationsByName(card.company_name_key)
    : [];

  // A kintone hit is decisive only when exactly one corporation carries a
  // corporate number and its normalized name equals the card's. Anything
  // weaker (partial substring matches, several candidates, no number) still
  // triggers a public registry search so both sets reach the human.
  const numberedKintone = kintoneCorps.filter((c) => c.corporate_number);
  const decisiveKintone =
    numberedKintone.length === 1 &&
    companyNameKey(numberedKintone[0]?.official_name ?? "") === card.company_name_key;

  let publicCandidates: CorporationCandidate[] = [];
  if (card.company_name_key && !decisiveKintone) {
    publicCandidates = (
      await registry.search({
        name: card.company_name_key,
        domain: card.domain,
      })
    ).filter(
      (c) =>
        !c.corporate_number ||
        !numberedKintone.some((k) => k.corporate_number === c.corporate_number),
    );
  }

  const corporateCandidates = [...kintoneCorps, ...publicCandidates];
  const decision = await decider.decide({
    card,
    existingContacts,
    corporateCandidates,
  });
  const autoConfirmable = ruleDecider
    ? ruleDecider.isAutoConfirmable(decision, {
        card,
        existingContacts,
        corporateCandidates,
      })
    : false;

  return {
    extraction: card,
    raw,
    existing_contacts: existingContacts.slice(0, 5),
    corporate_candidates: corporateCandidates.slice(0, 10),
    decision,
    auto_confirmable: autoConfirmable,
  };
}
