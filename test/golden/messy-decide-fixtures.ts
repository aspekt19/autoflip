/**
 * Realistic messy find_decide SERV answers that must still validate to a verdict.
 * No live SERV — offline extractServJson + validateFindDecide only.
 */

export const MESSY_SHORTLIST_KEYS = ["synth-a", "synth-b", "synth-c"] as const;

export const MESSY_SHORTLIST_META = [
  { key: "synth-a", vin: "1HGCM82633A004352", year: 2018, make: "Honda", model: "Accord" },
  { key: "synth-b", vin: "2T1BURHE0JC000001", year: 2019, make: "Toyota", model: "Corolla" },
  { key: "synth-c", vin: "3VW2B7AJ5HM000003", year: 2017, make: "Volkswagen", model: "Jetta" },
] as const;

export const MESSY_EVIDENCE_IDS = [
  "car:synth-a",
  "car:synth-b",
  "car:synth-c",
  "ask:synth-a",
  "fair:synth-a",
  "comps:synth-a",
] as const;

function decideBody(over: Record<string, unknown> = {}) {
  return {
    pickKey: "synth-a",
    action: "negotiate",
    confidence: "medium",
    confidenceWhy: "Fits the budget with fewer miles than the next car.",
    reasons: [
      {
        text: "Asking price sits near similar cars nearby.",
        evidenceIds: ["car:synth-a", "fair:synth-a"],
      },
    ],
    watchOuts: [],
    askSeller: ["Ask for service records."],
    alternatives: [{ key: "synth-b", whyNot: "Higher miles." }],
    offerUsd: 16_500,
    ...over,
  };
}

/** Fenced JSON (```json ... ```). */
export const MESSY_FENCED = `\`\`\`json
${JSON.stringify(decideBody({ action: "Buy", confidence: "Medium", offerUsd: "16500" }), null, 2)}
\`\`\``;

/** Prose before the JSON object. */
export const MESSY_PROSE = `Here is my choice after reviewing the shortlist.

${JSON.stringify(
  decideBody({
    pickKey: "car:synth-a",
    action: "needs_inspection",
    confidence: "MEDIUM",
    offerUsd: null,
  }),
)}

That is the full answer.`;

/** String offerUsd + wrong-case action/confidence. */
export const MESSY_STRING_NUMBERS = JSON.stringify(
  decideBody({
    action: "Negotiate",
    confidence: "Medium",
    offerUsd: "16,500",
  }),
);

/** VIN instead of shortlist key. */
export const MESSY_VIN_PICK = JSON.stringify(
  decideBody({
    pickKey: "1HGCM82633A004352",
    action: "needs_inspection",
    confidence: "medium",
    offerUsd: null,
  }),
);

/** car:VIN prefix form. */
export const MESSY_CAR_VIN_PREFIX = JSON.stringify(
  decideBody({
    pickKey: "vin:1HGCM82633A004352",
    action: "Buy",
    confidence: "High",
    offerUsd: "16000",
  }),
);

export const ALL_MESSY_DECIDE_ANSWERS = [
  { id: "fenced", text: MESSY_FENCED },
  { id: "prose", text: MESSY_PROSE },
  { id: "string_numbers", text: MESSY_STRING_NUMBERS },
  { id: "vin_pick", text: MESSY_VIN_PICK },
  { id: "car_vin_prefix", text: MESSY_CAR_VIN_PREFIX },
] as const;
