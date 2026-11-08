/**
 * Flip t318 decision shortlist — exact console catalog IDs only.
 *
 * Source CSV: uploads/all-models-20261108_c8cc.csv
 * Source readme: uploads/all-models-20261108-readme_80ae.txt
 * Captured: Sunday Nov 8, 2026 (console Available models; 31 rows).
 *
 * Display prices are transcription only — NOT capability/quality claims.
 * Names/tier ≠ ability proof. No 31-model blind paid matrix.
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
  /** Parent run order — 1 = baseline, then next, then if-needed. */
  flipOrder: 1 | 2 | 3;
  flipRole: "baseline" | "next" | "next_if_needed";
};

/**
 * Parent DECISION shortlist (exact CSV model_id values).
 * Order: Sonnet 5.5 → gpt-6.1-sol → claude-opus-5.5.
 */
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
  },
  {
    modelId: "gpt-6.1-sol",
    displayName: "GPT-6.1 Sol",
    providerLogoAlt: "OpenAI",
    contextWindow: "1M",
    inputPerMDisplay: "$2.40",
    cachedPerMDisplay: "$0.120",
    outputPerMDisplay: "$12.00",
    listedAvailability: "Listed under Available models",
    capabilityIndicators: "Not separately shown",
    flipOrder: 2,
    flipRole: "next",
  },
  {
    modelId: "claude-opus-5.5",
    displayName: "Claude Opus 5.5",
    providerLogoAlt: "Anthropic",
    contextWindow: "1M",
    inputPerMDisplay: "$4.80",
    cachedPerMDisplay: "$0.240",
    outputPerMDisplay: "$24.00",
    listedAvailability: "Listed under Available models",
    capabilityIndicators: "Not separately shown",
    flipOrder: 3,
    flipRole: "next_if_needed",
  },
] as const;

export const SERV_FLIP_DECISION_SHORTLIST_IDS = SERV_FLIP_DECISION_SHORTLIST.map(
  (e) => e.modelId,
) as readonly string[];

export function isFlipDecisionShortlistId(id: string): boolean {
  return SERV_FLIP_DECISION_SHORTLIST_IDS.includes(id);
}

export function flipDecisionShortlistNote(): string {
  return [
    "Flip t318 decision shortlist (console CSV exact IDs; display prices ≠ capability):",
    ...SERV_FLIP_DECISION_SHORTLIST.map(
      (e) =>
        `  ${e.flipOrder}. ${e.modelId} (${e.displayName}) [${e.providerLogoAlt}] context=${e.contextWindow} in=${e.inputPerMDisplay} cached=${e.cachedPerMDisplay} out=${e.outputPerMDisplay} — role=${e.flipRole}`,
    ),
    "Do NOT run all 31 Available models. Names/tier ≠ ability proof.",
    "Currency caveat: UI $ /M display preserved; not independently currency-verified.",
    "No model was enabled/subscribed/run by the catalog capture agent.",
  ].join("\n");
}
