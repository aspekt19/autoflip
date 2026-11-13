/**
 * Decision-only helpers for the frozen snapshot.
 * No network. The live runner calls SERV with these shapes.
 */
import { buildAgentServFeatureBundle, mergeResponsesTools } from "../../src/server/serv/agent-serv-features";
import { buildServResponsesTurnBody } from "../../src/server/serv/agent-chat-turn";
import { extractResponsesFunctionCalls } from "../../src/server/serv/agent-tool-loop-protocol";
import { extractAgentServCallUsage } from "../../src/server/serv/response-failure";
import { USD_PER_SERV_CALL } from "../live/spend";
import { readProviderCost } from "./score";
import type { ProviderCost, SearchSnapshot, SnapshotArmDecision } from "./types";

export const SNAPSHOT_DECISION_MAX_OUTPUT_TOKENS = 8_192;

const SUBMIT_PICKS_TOOL = {
  type: "function" as const,
  name: "submit_picks",
  description:
    "Choose at most one car from the snapshot, or say nothing fits. openingOffer and walkAway are the only offer figures. Do not invent a VIN.",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      primaryVin: { type: ["string", "null"] },
      nothingFits: { type: "boolean" },
      nearMissVins: { type: "array", items: { type: "string" } },
      openingOffer: { type: ["number", "null"] },
      walkAway: { type: ["number", "null"] },
      why: { type: "string" },
    },
    required: ["primaryVin", "nothingFits", "nearMissVins", "openingOffer", "walkAway", "why"],
  },
};

export function decisionRequestBody(input: {
  snapshot: SearchSnapshot;
  servVerdictFeatures: "on" | "off";
}): Record<string, unknown> {
  const bundle = buildAgentServFeatureBundle({
    product: "find",
    step: "verdict",
    includePromptGuard: input.servVerdictFeatures === "on",
    servVerdictFeatures: input.servVerdictFeatures,
  });
  const visible = {
    note: input.snapshot.note,
    buyerZip: input.snapshot.buyerZip,
    radiusMi: input.snapshot.radiusMi,
    budgetUsd: input.snapshot.budgetUsd,
    hardConstraints: input.snapshot.hardConstraints,
    candidates: input.snapshot.candidates,
    evidence: input.snapshot.evidence,
  };
  return buildServResponsesTurnBody({
    model: bundle.model,
    instructions: [
      "You are deciding a used-car purchase from one frozen candidate snapshot.",
      "Do not ask for another search. Use only the cars in the snapshot.",
      "Hard rules: stay inside the budget, respect a known radius, and do not pick a car with accidentCount >= 1 or a salvage/title brand when the brief forbids accidents.",
      "Unknown accident history and unverified distance are allowed. Say so in why.",
      "Call submit_picks once. Set openingOffer and walkAway. If nothing clean fits, nothingFits=true and name the near-miss VINs.",
    ].join(" "),
    input: `Snapshot ${input.snapshot.id}. Choose from these cars only:\n${JSON.stringify(visible)}`,
    tools: mergeResponsesTools(bundle.responsesExtensionTools, [SUBMIT_PICKS_TOOL]),
    toolChoice: "required",
    reasoning: { effort: "low", summary: "auto" },
    maxTokens: SNAPSHOT_DECISION_MAX_OUTPUT_TOKENS,
  });
}

export function parseSnapshotDecision(
  payload: unknown,
  servVerdictFeatures: "on" | "off",
): SnapshotArmDecision | null {
  const output =
    payload && typeof payload === "object"
      ? (payload as { output?: unknown }).output
      : null;
  const calls = extractResponsesFunctionCalls(output);
  const submit = calls.find((call) => call.name === "submit_picks");
  const raw = submit?.arguments;
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const row = parsed as Record<string, unknown>;
  const primary =
    typeof row.primaryVin === "string" && row.primaryVin.trim()
      ? row.primaryVin.trim().toUpperCase()
      : null;
  const near = Array.isArray(row.nearMissVins)
    ? row.nearMissVins
        .filter((vin): vin is string => typeof vin === "string" && vin.trim().length > 0)
        .map((vin) => vin.trim().toUpperCase())
    : [];
  const money = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
  return {
    servVerdictFeatures,
    primaryVin: primary,
    nothingFits: row.nothingFits === true,
    nearMissVins: near,
    openingOffer: money(row.openingOffer),
    walkAway: money(row.walkAway),
    why: typeof row.why === "string" ? row.why.trim() : "",
  };
}

export function responseIdFrom(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  if (typeof row.id === "string" && row.id.trim()) return row.id.trim();
  if (typeof row.response_id === "string" && row.response_id.trim()) return row.response_id.trim();
  return null;
}

export function modelFrom(payload: unknown, fallback: string): string {
  if (!payload || typeof payload !== "object") return fallback;
  const model = (payload as { model?: unknown }).model;
  return typeof model === "string" && model.trim() ? model.trim() : fallback;
}

/** Provider cost when the API sent one; otherwise a labeled harness estimate. */
export function costForDecision(payload: unknown, servCalls: number): ProviderCost & {
  usage: ReturnType<typeof extractAgentServCallUsage>;
  note: string;
} {
  const usage = extractAgentServCallUsage(payload);
  const withUsage = payload && typeof payload === "object"
    ? { ...(payload as Record<string, unknown>), providerCost: usage?.cost ?? undefined }
    : payload;
  const read = readProviderCost(withUsage);
  if (read.source === "provider" && read.usd != null) {
    return { ...read, usage, note: "Provider cost field on the SERV response." };
  }
  const estimate = Math.round(servCalls * USD_PER_SERV_CALL * 100) / 100;
  return {
    usd: estimate,
    source: "harness estimate",
    usage,
    note: `No provider cost on the response. Estimate is ${servCalls} call(s) × $${USD_PER_SERV_CALL} from eval/live/spend.ts, not an invoice.`,
  };
}

export function criterionWinner(
  offPass: boolean,
  onPass: boolean,
): "features_off" | "features_on" | "tie" | "neither" {
  if (offPass && onPass) return "tie";
  if (offPass) return "features_off";
  if (onPass) return "features_on";
  return "neither";
}
