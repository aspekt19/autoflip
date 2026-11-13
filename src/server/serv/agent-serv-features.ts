/**
 * SERV Reasoning extensions for agentic Find/Resale loops.
 *
 * Cost model (OpenServ docs — prompt-caching + usage-and-billing):
 * - Cache key = system prompt + SERV transformation type (+ prompt versions),
 *   NOT the application model. Put variable data in input messages.
 * - Kronos audit/repair bills on cache miss; Multipath is a separate transform;
 *   prompt_guard and shadow_agent are extra billable steps.
 *
 * Step policy:
 * - intake / search: bare BASE_MODEL (standard SERV transform), no shadow
 * - verdict (dedicated selection hop only — not text→terminal repair / retries):
 *   Find → kronos-multipath + shadow; Resale → multipath + shadow
 * - serv_prompt_guard only on the first user message of a chat (first SERV call)
 *
 * Application tools stay stable and in fixed order; only serv_* markers vary by step.
 */
import type { ServResponsesToolDef } from "./agent-chat-turn";
import {
  BASE_MODEL,
  FLIP_SHADOW_HINT,
  SHADOW_MAX_ITERATIONS,
  bareServModelId,
  type DocumentedFeature,
} from "./profiles";
import { shadowOutcomeFrom } from "./proof";

export type ServFeatureKind = "none" | "multipath" | "kronos" | "kronos-multipath";

/** Per-hop role inside the agent loop. */
export type AgentServStep = "intake" | "search" | "verdict";

/**
 * Comfortable output ceilings per step (Responses `max_output_tokens`).
 * Docs: use a reasonable ceiling so balance checks pass; avoid tight caps that
 * truncate tool calls / reasoning ("model anxiety").
 */
export const AGENT_STEP_MAX_OUTPUT_TOKENS: Record<AgentServStep, number> = {
  intake: 8_192,
  search: 16_384,
  verdict: 65_536,
};

export type AgentServFeatureRejection = {
  feature: string;
  status: number;
  error: string;
  endpoint: "responses" | "chat";
  /** True when we kept requesting the feature on later turns (no silent drop). */
  keptRequesting: true;
};

export type AgentServFeatureJournal = {
  model: string;
  step: AgentServStep;
  features: DocumentedFeature[];
  promptGuard: "requested" | "not_used";
  shadowRequested: boolean;
  shadowMaxIterations: number | null;
  shadowOutcome: string | null;
  contentFilter: "default_on";
  promptCache: "default";
  reasoningEffort: "low" | "medium" | "high";
  maxOutputTokens: number;
  featureRejections: AgentServFeatureRejection[];
};

export type AgentServFeatureBundle = {
  product: "find" | "resale";
  step: AgentServStep;
  feature: ServFeatureKind;
  model: string;
  reasoningEffort: "low" | "medium";
  shadowHint: string;
  shadowMaxIterations: number;
  hasPromptGuard: boolean;
  hasShadow: boolean;
  maxOutputTokens: number;
  /** Flat Responses tools: Prompt Guard + Shadow Agent (prepend before app tools). */
  responsesExtensionTools: ServResponsesToolDef[];
  /** Chat-shaped tools for structured finish / next_action when features are requested. */
  chatExtensionTools: Array<{
    type: "function";
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }>;
  features: DocumentedFeature[];
};

const STRICT_EMPTY_OBJECT_PARAMS = {
  type: "object",
  properties: {},
  required: [] as string[],
  additionalProperties: false,
} as const;

const FIND_AGENT_SHADOW_HINT =
  "Every pick VIN must appear in prior tool listing results. offerUsd must be ≤ budget and ≤ asking when known. Never invent cars, prices, VINs, or mileage. Separate facts from estimates. List what still needs checking.";

const RESALE_AGENT_SHADOW_HINT = [
  FLIP_SHADOW_HINT,
  "Use only code flipPnl / get_flip_pnl dollars for fees, tax, recon, and expected resale.",
  "buy|negotiate only when code mid-profit is non-negative; otherwise pass or needs_inspection.",
].join(" ");

/** Apply the same model-suffix rules as modelFor / requestFor. */
export function servModelWithFeature(
  requested: string,
  feature: ServFeatureKind,
): string {
  const base = bareServModelId(requested);
  if (feature === "kronos-multipath") return `${base}-serv-kronos-multipath`;
  if (feature === "kronos") return `${base}-serv-kronos`;
  if (feature === "multipath") return `${base}-serv-multipath`;
  return base;
}

function promptGuardResponsesTool(): ServResponsesToolDef {
  return {
    type: "function",
    name: "serv_prompt_guard",
    description: "OpenServ Prompt Guard marker (input gate).",
    parameters: { ...STRICT_EMPTY_OBJECT_PARAMS, required: [...STRICT_EMPTY_OBJECT_PARAMS.required] },
  };
}

function shadowResponsesTool(hint: string, maxIterations: number): ServResponsesToolDef {
  // OpenServ docs: hint / max_iterations use JSON Schema `default` (not enums).
  return {
    type: "function",
    name: "serv_shadow_agent",
    description: "Enable SERV shadow-agent validation.",
    parameters: {
      type: "object",
      properties: {
        hint: { type: "string", default: hint },
        max_iterations: { type: "integer", default: maxIterations },
      },
    },
  };
}

function promptGuardChatTool() {
  return {
    type: "function" as const,
    function: {
      name: "serv_prompt_guard",
      description: "OpenServ Prompt Guard marker (input gate).",
      parameters: { ...STRICT_EMPTY_OBJECT_PARAMS, required: [...STRICT_EMPTY_OBJECT_PARAMS.required] },
    },
  };
}

function shadowChatTool(hint: string, maxIterations: number) {
  return {
    type: "function" as const,
    function: {
      name: "serv_shadow_agent",
      description: "Enable SERV shadow-agent validation.",
      parameters: {
        type: "object",
        properties: {
          hint: { type: "string", default: hint },
          max_iterations: { type: "integer", default: maxIterations },
        },
      },
    },
  };
}

function featuresFor(bundle: {
  feature: ServFeatureKind;
  hasPromptGuard: boolean;
  hasShadow: boolean;
  reasoningEffort: string;
  onResponses: boolean;
}): DocumentedFeature[] {
  const used: DocumentedFeature[] = [];
  if (bundle.hasPromptGuard) used.push("serv_prompt_guard");
  used.push("content_filter");
  if (bundle.hasShadow) used.push("serv_shadow_agent");
  if (bundle.feature === "multipath" || bundle.feature === "kronos-multipath") used.push("multipath");
  if (bundle.feature === "kronos" || bundle.feature === "kronos-multipath") used.push("kronos");
  if (bundle.reasoningEffort) used.push("reasoning_effort");
  used.push("prompt_cache");
  if (bundle.onResponses) used.push("responses_reasoning");
  used.push("usage");
  return used;
}

/**
 * Resolve which agent step this SERV call is.
 * Chat path: intake until brief confirmed. Search hops stay bare (even after
 * searchCount > 0). Kronos/Multipath/Shadow only on the dedicated final
 * selection hop that can accept submit_picks / submit_nothing_fits — never on
 * text→terminal repair or validation-retry hops (submitNudgeSent alone does not
 * flip to verdict).
 */
export function resolveAgentServStep(input: {
  requireBriefConfirm: boolean;
  briefConfirmed: boolean;
  /** Kept for call-site compatibility; does not flip to verdict by itself. */
  searchCount: number;
  /** Kept for call-site compatibility; does not flip to verdict by itself. */
  submitNudgeSent: boolean;
  /** True only on the dedicated final selection hop. */
  selectionHop?: boolean;
}): AgentServStep {
  if (input.requireBriefConfirm && !input.briefConfirmed) return "intake";
  if (input.selectionHop === true) return "verdict";
  return "search";
}

export function buildAgentServFeatureBundle(input: {
  product: "find" | "resale";
  step: AgentServStep;
  /** Prompt Guard only on the first SERV call of a chat. */
  includePromptGuard: boolean;
  baseModel?: string;
}): AgentServFeatureBundle {
  const baseModel = input.baseModel ?? BASE_MODEL;
  const shadowHint =
    input.product === "find" ? FIND_AGENT_SHADOW_HINT : RESALE_AGENT_SHADOW_HINT;
  const shadowMaxIterations = SHADOW_MAX_ITERATIONS;
  const reasoningEffort = "low" as const;
  const maxOutputTokens = AGENT_STEP_MAX_OUTPUT_TOKENS[input.step];

  let feature: ServFeatureKind = "none";
  let hasShadow = false;
  if (input.step === "verdict") {
    hasShadow = true;
    feature = input.product === "find" ? "kronos-multipath" : "multipath";
  }

  const hasPromptGuard = input.includePromptGuard === true;
  const responsesExtensionTools: ServResponsesToolDef[] = [];
  const chatExtensionTools: AgentServFeatureBundle["chatExtensionTools"] = [];
  if (hasPromptGuard) {
    responsesExtensionTools.push(promptGuardResponsesTool());
    chatExtensionTools.push(promptGuardChatTool());
  }
  if (hasShadow) {
    responsesExtensionTools.push(shadowResponsesTool(shadowHint, shadowMaxIterations));
    chatExtensionTools.push(shadowChatTool(shadowHint, shadowMaxIterations));
  }

  return {
    product: input.product,
    step: input.step,
    feature,
    model: servModelWithFeature(baseModel, feature),
    reasoningEffort,
    shadowHint,
    shadowMaxIterations,
    hasPromptGuard,
    hasShadow,
    maxOutputTokens,
    responsesExtensionTools,
    chatExtensionTools,
    features: featuresFor({
      feature,
      hasPromptGuard,
      hasShadow,
      reasoningEffort,
      onResponses: true,
    }),
  };
}

/**
 * Find verdict bundle (kronos-multipath + prompt_guard + shadow).
 * Prefer buildAgentServFeatureBundle with an explicit step in the agent loop.
 */
export function findAgentServFeatureBundle(
  baseModel: string = BASE_MODEL,
): AgentServFeatureBundle {
  return buildAgentServFeatureBundle({
    product: "find",
    step: "verdict",
    includePromptGuard: true,
    baseModel,
  });
}

/**
 * Resale verdict bundle (multipath + prompt_guard + shadow).
 * Prefer buildAgentServFeatureBundle with an explicit step in the agent loop.
 */
export function resaleAgentServFeatureBundle(
  baseModel: string = BASE_MODEL,
): AgentServFeatureBundle {
  return buildAgentServFeatureBundle({
    product: "resale",
    step: "verdict",
    includePromptGuard: true,
    baseModel,
  });
}

/** Merge OpenServ extension tools ahead of application tools (order matches runServ). */
export function mergeResponsesTools(
  extensionTools: readonly ServResponsesToolDef[],
  applicationTools: readonly ServResponsesToolDef[],
): ServResponsesToolDef[] {
  return [...extensionTools, ...applicationTools];
}

export function journalFromBundle(
  bundle: AgentServFeatureBundle,
  opts?: {
    shadowOutcome?: string | null;
    featureRejections?: AgentServFeatureRejection[];
    endpoint?: "responses" | "chat";
  },
): AgentServFeatureJournal {
  const onResponses = (opts?.endpoint ?? "responses") === "responses";
  return {
    model: bundle.model,
    step: bundle.step,
    features: featuresFor({
      feature: bundle.feature,
      hasPromptGuard: bundle.hasPromptGuard,
      hasShadow: bundle.hasShadow,
      reasoningEffort: bundle.reasoningEffort,
      onResponses,
    }),
    promptGuard: bundle.hasPromptGuard ? "requested" : "not_used",
    shadowRequested: bundle.hasShadow,
    shadowMaxIterations: bundle.hasShadow ? bundle.shadowMaxIterations : null,
    shadowOutcome: opts?.shadowOutcome ?? null,
    contentFilter: "default_on",
    promptCache: "default",
    reasoningEffort: bundle.reasoningEffort,
    maxOutputTokens: bundle.maxOutputTokens,
    featureRejections: opts?.featureRejections ?? [],
  };
}

/**
 * Detect OpenServ rejecting/ignoring a requested extension.
 * Never used to silently strip features — only to journal the exact error.
 */
export function classifyAgentFeatureRejection(input: {
  status: number;
  payload: unknown;
  error?: string;
  endpoint: "responses" | "chat";
  requestedFeatures: readonly string[];
}): AgentServFeatureRejection[] {
  if (input.status >= 200 && input.status < 300) return [];
  const blob = [
    input.error ?? "",
    typeof input.payload === "string" ? input.payload : JSON.stringify(input.payload ?? null),
  ]
    .join(" ")
    .toLowerCase();

  const hits: AgentServFeatureRejection[] = [];
  const candidates: Array<{ feature: string; needles: string[] }> = [
    { feature: "serv_prompt_guard", needles: ["serv_prompt_guard", "prompt_guard", "prompt guard"] },
    { feature: "serv_shadow_agent", needles: ["serv_shadow_agent", "shadow_agent", "shadow agent"] },
    { feature: "multipath", needles: ["multipath", "-serv-multipath"] },
    { feature: "kronos", needles: ["kronos", "-serv-kronos"] },
    { feature: "responses_reasoning", needles: ["reasoning_effort", "reasoning.effort", "function tools with reasoning"] },
    { feature: "json_schema", needles: ["json_schema", "response_format", "text.format"] },
  ];

  for (const row of candidates) {
    if (!input.requestedFeatures.includes(row.feature) && row.feature !== "responses_reasoning") {
      // Still flag if the error names a feature we requested under an alias.
      if (!input.requestedFeatures.some((f) => row.feature.includes(f) || f.includes(row.feature))) {
        // Only record when the error text names it OR we requested it.
        if (!row.needles.some((n) => blob.includes(n))) continue;
      }
    }
    if (!row.needles.some((n) => blob.includes(n))) {
      if (!input.requestedFeatures.includes(row.feature)) continue;
      // Generic 4xx with no feature name — attach once under "serv_extensions" below.
      continue;
    }
    hits.push({
      feature: row.feature,
      status: input.status,
      error: summarizeServErrorPayload(input.payload, input.error),
      endpoint: input.endpoint,
      keptRequesting: true,
    });
  }

  if (hits.length === 0 && input.status >= 400) {
    hits.push({
      feature: "serv_extensions",
      status: input.status,
      error: summarizeServErrorPayload(input.payload, input.error),
      endpoint: input.endpoint,
      keptRequesting: true,
    });
  }
  return hits;
}

export function summarizeServErrorPayload(payload: unknown, fallback?: string): string {
  if (fallback && fallback.trim()) return fallback.trim().slice(0, 600);
  if (!payload) return "empty error payload";
  if (typeof payload === "string") return payload.slice(0, 600);
  try {
    const record = payload as { error?: unknown; message?: unknown };
    if (typeof record.message === "string" && record.message.trim()) return record.message.trim().slice(0, 600);
    if (record.error && typeof record.error === "object") {
      const err = record.error as { message?: unknown; code?: unknown };
      const parts = [err.code, err.message].filter((v) => typeof v === "string" && v.trim());
      if (parts.length) return parts.join(": ").slice(0, 600);
    }
    return JSON.stringify(payload).slice(0, 600);
  } catch {
    return "unparseable error payload";
  }
}

export function shadowOutcomeForAgentTurn(payload: unknown, headers?: Headers): string {
  return shadowOutcomeFrom(payload, headers ?? new Headers());
}

/** Human-readable flag lines for PR / eval reports — never silent. */
export function formatFeatureRejectionFlags(
  rejections: readonly AgentServFeatureRejection[],
): string[] {
  return rejections.map(
    (r) =>
      `FEATURE_REJECTION endpoint=${r.endpoint} feature=${r.feature} status=${r.status} keptRequesting=true error=${r.error}`,
  );
}
