/**
 * Documented agent verdict JSON schema for Find / Check / report / future agent API.
 *
 * Numbers and evidence come from code. The model may choose pick/verdict/confidence
 * language only when every claim cites an evidence id that appears in the supplied set.
 * Consumer UI must never invent trail steps; if a run had no agent step, say so plainly.
 */

import type { DecisionAction } from "./decision-action";
import type { FindChoiceConfidence } from "./find-close-call";

export const AGENT_VERDICT_SCHEMA_VERSION = "lemonless.agent_verdict.v1" as const;

export type AgentVerdictConfidence = FindChoiceConfidence;

export type AgentEvidenceRef = {
  /** Stable id from the run's evidence set (check id, receipt id, flag id, etc.). */
  evidenceId: string;
  text: string;
};

export type AgentTrailStep = {
  /**
   * Structured buyer trail — not a raw hop dump.
   * decided → why → changed (null when nothing moved).
   */
  decided: string;
  why: string;
  changed: string | null;
  /** Optional evidence ids supporting this step. */
  evidenceIds?: string[];
  /** SERV model when this step came from a recorded agent call. */
  model?: string | null;
  /** OpenSERV response id when the provider returned one. */
  responseId?: string | null;
  /** ISO timestamp when the call was recorded. */
  recordedAt?: string | null;
  /** Raw SERV response for this step when recorded — never invent. */
  rawResponse?: string | null;
};

export type AgentMultipathPathId = "price_first" | "risk_first" | "total_cost_first";

export type AgentMultipathPath = {
  id: AgentMultipathPathId;
  label: string;
  pickKey: string | null;
  pickLabel: string | null;
  summary: string;
  evidenceIds: string[];
};

export type AgentMultipathResult = {
  paths: AgentMultipathPath[];
  reconciliation: string;
  finalPickKey: string | null;
  finalPickLabel: string | null;
  /** serv = a separate agent call returned the paths. code = ranked from recorded asks and checks. */
  source: "serv" | "code";
};

export type AgentSecondPassStatus =
  | "agreed"
  | "disagreed"
  | "skipped_no_budget"
  | "skipped_no_key"
  | "ignored_malformed"
  | "ignored_no_evidence"
  | "unavailable"
  | "not_run";

export type AgentSecondPassResult = {
  status: AgentSecondPassStatus;
  /** Challenger's action when parsed and evidence-backed (or agreed). */
  action: Exclude<DecisionAction, "withheld"> | null;
  /**
   * Buyer-facing note. On unavailable, a short label only
   * (`Second check unavailable: <reason>`) — never the raw upstream dump.
   */
  objection: string | null;
  /**
   * Optional raw upstream / diagnostic dump for a collapsible UI field.
   * Never invent; omit or null when nothing was recorded.
   */
  rawDump?: string | null;
  evidenceIds: string[];
  confidenceBefore: AgentVerdictConfidence | null;
  confidenceAfter: AgentVerdictConfidence | null;
  /** SERV profile that produced this second check when known (e.g. resale_challenge). */
  profile?: string | null;
  /** Upstream response id for the challenge call — cite in UI when agreed/disagreed. */
  responseId?: string | null;
};

export type AgentServSpend = {
  /** Paid agent calls recorded for this run (Find hop count or report profile calls). */
  calls: number;
  /** Plain cost note when a figure was recorded; otherwise null. Never invent a dollar amount. */
  costNote: string | null;
};

/**
 * Canonical verdict object exported for UI and future agent API.
 * Field names are stable; prefer snake_case mirrors in JSON export.
 */
export type AgentVerdict = {
  schemaVersion: typeof AGENT_VERDICT_SCHEMA_VERSION;
  pick: { key: string; label: string } | null;
  verdict: DecisionAction | null;
  reasons: AgentEvidenceRef[];
  risks: AgentEvidenceRef[];
  confidence: AgentVerdictConfidence | null;
  unknowns: string[];
  /** Structured trail: what the agent decided → why → what changed. */
  serv_steps: AgentTrailStep[];
  second_pass: AgentSecondPassResult | null;
  multipath: AgentMultipathResult | null;
  /** One-line comparison vs just picking the cheapest usable ask. */
  vs_cheapest: string | null;
  serv_spend: AgentServSpend | null;
  /** True when this run never invoked an agent step. */
  no_serv_step: boolean;
};

/** JSON Schema (draft-07 style) for documentation and future agent API validation. */
export const AGENT_VERDICT_JSON_SCHEMA = {
  $id: "https://lemonless.app/schemas/agent-verdict.v1.json",
  title: "LemonlessAgentVerdict",
  description:
    "Documented agent verdict for Find shortlist picks and Check/report shopper actions. Claims must cite evidence ids from the run. Exported for future agent API use.",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "pick",
    "verdict",
    "reasons",
    "risks",
    "confidence",
    "unknowns",
    "serv_steps",
    "second_pass",
    "multipath",
    "vs_cheapest",
    "serv_spend",
    "no_serv_step",
  ],
  properties: {
    schemaVersion: { type: "string", const: AGENT_VERDICT_SCHEMA_VERSION },
    pick: {
      oneOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["key", "label"],
          properties: {
            key: { type: "string" },
            label: { type: "string" },
          },
        },
      ],
    },
    verdict: {
      oneOf: [
        { type: "null" },
        {
          type: "string",
          enum: ["buy", "negotiate", "pass", "needs_inspection", "withheld"],
        },
      ],
    },
    reasons: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["evidenceId", "text"],
        properties: {
          evidenceId: { type: "string" },
          text: { type: "string" },
        },
      },
    },
    risks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["evidenceId", "text"],
        properties: {
          evidenceId: { type: "string" },
          text: { type: "string" },
        },
      },
    },
    confidence: {
      oneOf: [{ type: "null" }, { type: "string", enum: ["high", "medium", "low"] }],
    },
    unknowns: { type: "array", items: { type: "string" } },
    serv_steps: {
      type: "array",
      description: "Structured trail: what the agent decided → why → what changed after revisit/second pass.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["decided", "why", "changed"],
        properties: {
          decided: { type: "string" },
          why: { type: "string" },
          changed: { oneOf: [{ type: "string" }, { type: "null" }] },
          evidenceIds: { type: "array", items: { type: "string" } },
        },
      },
    },
    second_pass: {
      oneOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: [
            "status",
            "action",
            "objection",
            "evidenceIds",
            "confidenceBefore",
            "confidenceAfter",
          ],
          properties: {
            status: {
              type: "string",
              enum: [
                "agreed",
                "disagreed",
                "skipped_no_budget",
                "skipped_no_key",
                "ignored_malformed",
                "ignored_no_evidence",
                "unavailable",
                "not_run",
              ],
            },
            action: {
              oneOf: [
                { type: "null" },
                {
                  type: "string",
                  enum: ["buy", "negotiate", "pass", "needs_inspection"],
                },
              ],
            },
            objection: { oneOf: [{ type: "string" }, { type: "null" }] },
            rawDump: { oneOf: [{ type: "string" }, { type: "null" }] },
            evidenceIds: { type: "array", items: { type: "string" } },
            confidenceBefore: {
              oneOf: [{ type: "null" }, { type: "string", enum: ["high", "medium", "low"] }],
            },
            confidenceAfter: {
              oneOf: [{ type: "null" }, { type: "string", enum: ["high", "medium", "low"] }],
            },
            profile: { oneOf: [{ type: "string" }, { type: "null" }] },
            responseId: { oneOf: [{ type: "string" }, { type: "null" }] },
          },
        },
      ],
    },
    multipath: {
      oneOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["paths", "reconciliation", "finalPickKey", "finalPickLabel", "source"],
          properties: {
            paths: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["id", "label", "pickKey", "pickLabel", "summary", "evidenceIds"],
                properties: {
                  id: {
                    type: "string",
                    enum: ["price_first", "risk_first", "total_cost_first"],
                  },
                  label: { type: "string" },
                  pickKey: { oneOf: [{ type: "string" }, { type: "null" }] },
                  pickLabel: { oneOf: [{ type: "string" }, { type: "null" }] },
                  summary: { type: "string" },
                  evidenceIds: { type: "array", items: { type: "string" } },
                },
              },
            },
            reconciliation: { type: "string" },
            finalPickKey: { oneOf: [{ type: "string" }, { type: "null" }] },
            finalPickLabel: { oneOf: [{ type: "string" }, { type: "null" }] },
            source: { type: "string", enum: ["serv", "code"] },
          },
        },
      ],
    },
    vs_cheapest: { oneOf: [{ type: "string" }, { type: "null" }] },
    serv_spend: {
      oneOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["calls", "costNote"],
          properties: {
            calls: { type: "integer", minimum: 0 },
            costNote: { oneOf: [{ type: "string" }, { type: "null" }] },
          },
        },
      ],
    },
    no_serv_step: { type: "boolean" },
  },
} as const;

export function emptyAgentVerdict(partial?: Partial<AgentVerdict>): AgentVerdict {
  return {
    schemaVersion: AGENT_VERDICT_SCHEMA_VERSION,
    pick: null,
    verdict: null,
    reasons: [],
    risks: [],
    confidence: null,
    unknowns: [],
    serv_steps: [],
    second_pass: null,
    multipath: null,
    vs_cheapest: null,
    serv_spend: null,
    no_serv_step: true,
    ...partial,
  };
}

export function lowerConfidenceOneLevel(
  level: AgentVerdictConfidence | null,
): AgentVerdictConfidence | null {
  if (level === "high") return "medium";
  if (level === "medium") return "low";
  if (level === "low") return "low";
  return null;
}

export function confidenceLabel(level: AgentVerdictConfidence | null): string {
  if (level === "high") return "High";
  if (level === "medium") return "Medium";
  if (level === "low") return "Low";
  return "Not rated";
}

const CONF_RANK: Record<AgentVerdictConfidence, number> = { high: 3, medium: 2, low: 1 };

/** Prefer the lower of two confidence labels (screening vs agent). */
export function moreConservativeConfidence(
  a: AgentVerdictConfidence | null | undefined,
  b: AgentVerdictConfidence | null | undefined,
): AgentVerdictConfidence | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return CONF_RANK[a] <= CONF_RANK[b] ? a : b;
}
