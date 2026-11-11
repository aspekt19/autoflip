/**
 * Flip production model shortlist — gpt-6.1-sol only (shared BASE_MODEL).
 *
 * Production SERV calls do not try Sonnet / Mini / prior Sol first.
 * Compare peers belong in the fair-slate / ALLOW_UNLISTED compare harness, not here.
 * claude-fable-5 remains EXCLUDED from paid Flip / production selection (owner t321).
 */

export type FlipDecisionShortlistEntry = {
  /** Exact console Model ID column. */
  modelId: string;
  displayName: string;
  providerLogoAlt: string;
  contextWindow: string;
  inputPerMDisplay: string;
  cachedPerMDisplay: string;
  outputPerMDisplay: string;
  listedAvailability: string;
  capabilityIndicators: string;
  /** Parent run order — production shortlist is a single entry. */
  flipOrder: 1;
  flipRole: "baseline";
  overviewHypothesis: string | null;
};

export const SERV_FLIP_DECISION_SHORTLIST: readonly FlipDecisionShortlistEntry[] = [
  {
    modelId: "gpt-6.1-sol",
    displayName: "GPT-6.1 Sol",
    providerLogoAlt: "OpenAI",
    contextWindow: "1M",
    inputPerMDisplay: "confirm console",
    cachedPerMDisplay: "confirm console",
    outputPerMDisplay: "confirm console",
    listedAvailability: "Listed under Available models",
    capabilityIndicators: "Not separately shown",
    flipOrder: 1,
    flipRole: "baseline",
    overviewHypothesis: "production BASE_MODEL for every SERV step — Flip confirms console rates",
  },
] as const;

/** Owner t321: do not spend Fable on Flip paid tests or production selection. */
export const SERV_FLIP_EXCLUDED_FROM_PAID = ["claude-fable-5"] as const;

/** Prior automatic-next / compare peers — not production defaults. */
export const SERV_FLIP_SUPERSEDED_AUTOMATIC_NEXT = [
  "claude-sonnet-5.5",
  "gpt-5.6-sol",
  "gpt-5.4-mini",
  "claude-opus-5.5",
] as const;

export const SERV_FLIP_DECISION_SHORTLIST_IDS = SERV_FLIP_DECISION_SHORTLIST.map(
  (e) => e.modelId,
) as readonly string[];

export function isFlipDecisionShortlistId(id: string): boolean {
  return SERV_FLIP_DECISION_SHORTLIST_IDS.includes(id);
}

export function flipDecisionShortlistNote(): string {
  return [
    "Flip production shortlist (gpt-6.1-sol only — shared BASE_MODEL):",
    ...SERV_FLIP_DECISION_SHORTLIST.map(
      (e) =>
        `  ${e.flipOrder}. ${e.modelId} (${e.displayName}) [${e.providerLogoAlt}] context=${e.contextWindow} in=${e.inputPerMDisplay} cached=${e.cachedPerMDisplay} out=${e.outputPerMDisplay} — role=${e.flipRole}${e.overviewHypothesis ? ` hypothesis=${e.overviewHypothesis}` : ""}`,
    ),
    `EXCLUDED from paid Flip / production selection (owner t321): ${SERV_FLIP_EXCLUDED_FROM_PAID.join(", ")}`,
    `Not production defaults (compare / superseded): ${SERV_FLIP_SUPERSEDED_AUTOMATIC_NEXT.join(", ")}`,
    "Do NOT run multi-model production matrices. Names/tier ≠ ability proof.",
  ].join("\n");
}
