/**
 * Configurable SERV Reasoning features for scout planner calls.
 * Sources (documented only — not runtime proof of Lemonless efficacy):
 * - https://docs.openserv.ai/serv-reasoning/day-one
 * - https://docs.openserv.ai/serv-reasoning/tools
 * - https://docs.openserv.ai/serv-reasoning/tutorials/structured-outputs
 * - https://docs.openserv.ai/serv-reasoning/tutorials/shadow-agent
 * - https://docs.openserv.ai/serv-reasoning/tutorials/kronos
 * - https://docs.openserv.ai/serv-reasoning/tutorials/multipath
 * - https://docs.openserv.ai/serv-reasoning/tutorials/prompt-caching
 * - https://docs.openserv.ai/serv-reasoning/tutorials/reasoning-effort
 *
 * Defaults are conservative. Kronos/multipath/cache/effort are opt-in measured options —
 * enable only when eval shows need. Never casually disable the default content filter.
 *
 * Live HTTP bodies use `PROFILES.scout_plan` — keep SCOUT_PLAN_JSON_SCHEMA aligned.
 */

export type ScoutServEffort = "none" | "low" | "medium" | "high";

export type ScoutServOptions = {
  /** Opt-in injection defense marker. Default on for planner. */
  promptGuard: boolean;
  /**
   * Default content filter must stay on unless explicitly justified.
   * When true, we never emit serv_disable_content_filter.
   */
  contentFilterDefaultOn: true;
  /** Shadow validate/revise loop — non-stream; extra cost per docs. Default off until measured. */
  shadowAgent: boolean;
  shadowHint: string;
  shadowMaxIterations: number;
  /** Strict JSON schema for planner action — still requires app-side validation. */
  strictJsonSchema: boolean;
  /** Model ID suffix primitives — not defaults; measure before enabling. */
  kronos: boolean;
  multipath: boolean;
  reasoningEffort: ScoutServEffort;
  /** Org prompt cache: default leaves SERV default; "disabled" opts out. */
  promptCache: "default" | "disabled";
};

export const SCOUT_SHADOW_HINT =
  "Return only one allowlisted next action as JSON. Cite only supplied VIN/tool outputs. Asking prices are seller claims. Never invent sold prices, title history, or verified profit. Abstain when evidence is insufficient.";

/** Conservative defaults for when a parent-assigned paid planner test is enabled later. */
export const DEFAULT_SCOUT_SERV_OPTIONS: ScoutServOptions = Object.freeze({
  promptGuard: true,
  contentFilterDefaultOn: true,
  shadowAgent: false,
  shadowHint: SCOUT_SHADOW_HINT,
  shadowMaxIterations: 2,
  strictJsonSchema: true,
  kronos: false,
  multipath: false,
  reasoningEffort: "low",
  promptCache: "default",
});

export function resolveScoutServOptions(partial?: Partial<ScoutServOptions>): ScoutServOptions {
  const merged: ScoutServOptions = {
    ...DEFAULT_SCOUT_SERV_OPTIONS,
    ...partial,
    // Hard safety: never allow turning the default filter off via this resolver.
    contentFilterDefaultOn: true,
  };
  if (merged.shadowMaxIterations < 1 || merged.shadowMaxIterations > 5) {
    throw new Error("shadowMaxIterations must be 1..5");
  }
  return Object.freeze(merged);
}

/** Planner action JSON Schema for response_format (documented structured outputs). */
export const SCOUT_PLAN_JSON_SCHEMA = {
  name: "lemonless_scout_plan_action",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "type",
      "reason",
      "servStepId",
      "vin",
      "toolId",
      "args",
      "rationaleKind",
      "citedEvidence",
      "assumptionsDisclosed",
    ],
    properties: {
      type: {
        type: "string",
        enum: ["select_candidate", "run_tool", "reject", "replace", "finalize", "abstain"],
      },
      // Twin of PROFILES.scout_plan — non-empty enforced at parse time, not schema pattern.
      reason: { type: "string" },
      servStepId: { type: "string" },
      vin: { type: ["string", "null"] },
      toolId: {
        type: ["string", "null"],
        enum: [
          null,
          "inventory.search",
          "listing.normalize",
          "evidence.asking_price",
          "evidence.comps_ask",
          "evidence.gov_recalls",
          "evidence.gov_fuel",
          "evidence.gov_vpic",
          "evidence.gov_safety",
          "economics.flip_estimate",
          "economics.personal_fit",
          "gates.verify",
          "candidate.reject",
          "candidate.replace",
          "run.checkpoint",
          "run.finalize",
        ],
      },
      args: {
        type: ["object", "null"],
        additionalProperties: false,
        required: [
          "makes",
          "models",
          "preferredMakes",
          "zip",
          "distanceMiles",
          "maxDistanceMiles",
          "maxPriceUsd",
          "priceMax",
          "maxPrice",
          "maxMiles",
          "milesMax",
          "maxMileage",
        ],
        properties: {
          makes: { type: ["array", "null"], items: { type: "string" } },
          models: { type: ["array", "null"], items: { type: "string" } },
          preferredMakes: { type: ["array", "null"], items: { type: "string" } },
          zip: { type: ["string", "null"] },
          distanceMiles: { type: ["number", "null"] },
          maxDistanceMiles: { type: ["number", "null"] },
          maxPriceUsd: { type: ["number", "null"] },
          priceMax: { type: ["number", "null"] },
          maxPrice: { type: ["number", "null"] },
          maxMiles: { type: ["number", "null"] },
          milesMax: { type: ["number", "null"] },
          maxMileage: { type: ["number", "null"] },
        },
      },
      rationaleKind: {
        type: ["string", "null"],
        enum: [null, "adverse_evidence", "uncertainty_progress"],
      },
      citedEvidence: {
        type: ["array", "null"],
        items: {
          type: "object",
          additionalProperties: false,
          required: ["kind", "gateId"],
          properties: {
            kind: {
              type: "string",
              enum: [
                "bad_title_brand",
                "over_budget",
                "over_miles",
                "flip_excluded",
                "missing_asking_price",
                "economics_estimate",
                "nhtsa_park_it",
              ],
            },
            gateId: { type: ["string", "null"] },
          },
        },
      },
      assumptionsDisclosed: { type: ["boolean", "null"] },
    },
  },
} as const;
