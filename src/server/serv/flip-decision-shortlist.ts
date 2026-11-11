/**
 * Flip decision shortlist — exact console catalog IDs (t319 corrected; t321 Fable excluded).
 *
 * Source CSV: uploads/all-models-20261108_c8cc.csv
 * Source readme: uploads/all-models-20261108-readme_80ae.txt
 *
 * Display prices are transcription only — NOT capability/quality claims.
 * Overview marketing cards are hypotheses — NOT measured ability.
 * Names/tier ≠ ability proof. No 31-model blind paid matrix.
 *
 * Order: Sonnet 5.5 → gpt-6.1-sol (production BASE_MODEL).
 * claude-fable-5 EXCLUDED from paid Flip / production selection (owner t321).
 * claude-opus-5.5 is NOT automatic next.
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
  /** Parent run order — 1 = baseline, then next. */
  flipOrder: 1 | 2;
  flipRole: "baseline" | "next";
  overviewHypothesis: string | null;
};

export const SERV_FLIP_DECISION_SHORTLIST: readonly FlipDecisionShortlistEntry[] = [
  {
    modelId: "claude-sonnet-5.5",
    displayName: "Claude Sonnet 5.5",
    providerLogoAlt: "Anthropic",
    contextWindow: "1M",
    inputPerMDisplay: "$2.40",
    cachedPerMDisplay: "$0.240",
    outputPerMDisplay: "$12.00",
    listedAvailability: "Listed under Available models",
    capabilityIndicators: "Not separately shown",
    flipOrder: 1,
    flipRole: "baseline",
    overviewHypothesis: null,
  },
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
    flipOrder: 2,
    flipRole: "next",
    overviewHypothesis: "production BASE_MODEL — Flip confirms console rates (display prices ≠ capability)",
  },
] as const;

/** Owner t321: do not spend Fable on Flip paid tests or production selection. */
export const SERV_FLIP_EXCLUDED_FROM_PAID = ["claude-fable-5"] as const;

/** Formerly automatic-next IDs — remain in catalog for Flip but are not the default order. */
export const SERV_FLIP_SUPERSEDED_AUTOMATIC_NEXT = ["gpt-5.6-sol", "claude-opus-5.5"] as const;

export const SERV_FLIP_DECISION_SHORTLIST_IDS = SERV_FLIP_DECISION_SHORTLIST.map(
  (e) => e.modelId,
) as readonly string[];

export function isFlipDecisionShortlistId(id: string): boolean {
  return SERV_FLIP_DECISION_SHORTLIST_IDS.includes(id);
}

export function flipDecisionShortlistNote(): string {
  return [
    "Flip decision shortlist (console CSV exact IDs; display prices ≠ capability; Overview = hypothesis):",
    ...SERV_FLIP_DECISION_SHORTLIST.map(
      (e) =>
        `  ${e.flipOrder}. ${e.modelId} (${e.displayName}) [${e.providerLogoAlt}] context=${e.contextWindow} in=${e.inputPerMDisplay} cached=${e.cachedPerMDisplay} out=${e.outputPerMDisplay} — role=${e.flipRole}${e.overviewHypothesis ? ` hypothesis=${e.overviewHypothesis}` : ""}`,
    ),
    `EXCLUDED from paid Flip / production selection (owner t321): ${SERV_FLIP_EXCLUDED_FROM_PAID.join(", ")}`,
    `Superseded as automatic next (still console-listed): ${SERV_FLIP_SUPERSEDED_AUTOMATIC_NEXT.join(", ")}`,
    "Do NOT run all 31 Available models. Names/tier ≠ ability proof.",
    "Gemini: no blind retry until content_null_refusal_field diagnostic confirmed.",
  ].join("\n");
}
