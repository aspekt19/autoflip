import type { DecisionProof } from "@/domain/decision-note";
import { profile, type ProfileId } from "./profiles";

export type OpenservReport = {
  id?: string;
  object?: string;
  model?: string;
  finish_reason?: string;
  usage?: unknown;
  output?: unknown;
  output_text?: string;
  proof?: unknown;
  report?: unknown;
  reasoning?: unknown;
};

export type ServProof = DecisionProof & {
  modelRequested: string;
  modelReported: string;
  reasoningEffort: string | null;
  contentFilter: string;
  promptCache: string;
  streamed: boolean;
  endpoint: string;
  openserv: OpenservReport | null;
};

const recent: ServProof[] = [];

/** One recorder for every profile. Callers also attach the returned proof to reports and radar runs. */
export function recordServProof(proof: ServProof): ServProof {
  recent.unshift(proof);
  if (recent.length > 40) recent.pop();
  return proof;
}

export function recentServProofs(): ServProof[] {
  return [...recent];
}

export function shadowOutcomeFrom(payload: unknown, headers: Headers): string {
  for (const [name, value] of headers.entries()) {
    if (name.toLowerCase().includes("shadow") && value.trim()) return value.trim().slice(0, 120);
  }
  const blob = JSON.stringify(payload).toLowerCase();
  if (/\bexhausted\b/.test(blob)) return "exhausted";
  return "not_exposed";
}

function toolNames(body: unknown): string[] {
  if (!body || typeof body !== "object" || !Array.isArray((body as { tools?: unknown }).tools)) return [];
  return (body as { tools: Array<{ name?: string; function?: { name?: string } }> }).tools
    .map((tool) => tool.function?.name || tool.name)
    .filter((name): name is string => Boolean(name));
}

function featureList(model: string): string[] {
  const features: string[] = [];
  if (/-serv-kronos/i.test(model)) features.push("kronos");
  if (/-serv-multipath/i.test(model)) features.push("multipath");
  return features;
}

function shadowMax(body: unknown): number | null {
  const tools = (body as { tools?: Array<{ name?: string; function?: { name?: string; parameters?: { properties?: { max_iterations?: { default?: number } } } }; parameters?: { properties?: { max_iterations?: { default?: number } } } }> }).tools;
  const shadow = tools?.find((tool) => (tool.function?.name || tool.name) === "serv_shadow_agent");
  const value = shadow?.function?.parameters?.properties?.max_iterations?.default ?? shadow?.parameters?.properties?.max_iterations?.default;
  return typeof value === "number" ? value : null;
}

export function interpretGuard(text: string): "allow" | "block" {
  if (/^\s*allow\b/i.test(text)) return "allow";
  return "block";
}

/** Copy documented response fields only when the body actually contains them. */
export function openservReportFrom(payload: unknown): OpenservReport | null {
  if (!payload || typeof payload !== "object") return null;
  const body = payload as Record<string, unknown>;
  const report: OpenservReport = {};
  const writable = report as Record<string, unknown>;
  for (const key of ["id", "object", "model", "usage", "output", "output_text", "proof", "report", "reasoning"] as const) {
    if (key in body && body[key] !== undefined) writable[key] = body[key];
  }
  const choice = Array.isArray(body.choices) ? (body.choices[0] as { finish_reason?: unknown } | undefined) : undefined;
  if (choice && typeof choice.finish_reason === "string") report.finish_reason = choice.finish_reason;
  return Object.keys(report).length > 0 ? report : null;
}

export function buildServProof(input: {
  purpose: string;
  body: unknown;
  payload: unknown;
  headers: Headers;
  status: number;
  ok: boolean;
  text: string;
  latencyMs: number;
  streamed?: boolean;
  endpoint?: string;
  reasoningEffort?: string | null;
  applicationTool?: string | null;
  jsonSchema?: string | null;
  codeComputed?: string[];
  fallbackUsed?: boolean;
  contentFilter?: string;
  promptCache?: string;
}): ServProof {
  const requested =
    input.body && typeof input.body === "object" && typeof (input.body as { model?: unknown }).model === "string"
      ? (input.body as { model: string }).model
      : "unknown";
  const reported =
    input.payload && typeof input.payload === "object" && typeof (input.payload as { model?: unknown }).model === "string"
      ? (input.payload as { model: string }).model
      : requested;
  const tools = toolNames(input.body);
  let promptGuard = "not_used";
  if (tools.includes("serv_prompt_guard")) {
    if (!input.ok && input.status === 502) promptGuard = "not_armed";
    else if (!input.ok && (input.status === 400 || input.status === 403)) promptGuard = "refused";
    else if (input.ok && input.purpose.endsWith("_guard")) promptGuard = interpretGuard(input.text);
    else if (input.ok) promptGuard = "passed";
    else promptGuard = "unavailable";
  }
  return {
    purpose: input.purpose,
    modelRequested: requested,
    modelReported: reported,
    tools,
    features: featureList(requested),
    promptGuard,
    shadowOutcome: tools.includes("serv_shadow_agent") ? shadowOutcomeFrom(input.payload, input.headers) : "not_used",
    shadowMaxIterations: shadowMax(input.body),
    latencyMs: input.latencyMs,
    reasoningEffort: input.reasoningEffort ?? null,
    contentFilter: input.contentFilter ?? "default_on",
    promptCache: input.promptCache ?? "default",
    streamed: Boolean(input.streamed),
    endpoint: input.endpoint ?? "chat",
    applicationTool: input.applicationTool ?? null,
    jsonSchema: input.jsonSchema ?? null,
    codeComputed: input.codeComputed ?? [],
    fallbackUsed: Boolean(input.fallbackUsed),
    openserv: openservReportFrom(input.payload),
  };
}

export type AgentProof = OpenservReport & {
  profiles: Array<{
    id: string;
    tools: string[];
    suffixes: string[];
    promptGuard: string;
    shadowOutcome: string;
    shadowMaxIterations: number | null;
    latencyMs: number;
    reasoningEffort: string | null;
    contentFilter: string;
    promptCache: string;
    streamed: boolean;
    endpoint: string;
    applicationTool: string | null;
    jsonSchema: string | null;
    codeComputed: string[];
    fallbackUsed: boolean;
    openserv: OpenservReport | null;
  }>;
  codeComputed: string[];
  responses: OpenservReport[];
};

/** Agent payload. OpenServ fields are copied verbatim from the last body that had them. */
export function agentProof(checks: ServProof[], codeComputed: string[] = []): AgentProof {
  const responses = checks.map((item) => item.openserv).filter((item): item is OpenservReport => item !== null);
  const latest = responses.length > 0 ? responses[responses.length - 1]! : {};
  const fields = [...codeComputed];
  for (const check of checks) {
    for (const field of check.codeComputed ?? []) {
      if (!fields.includes(field)) fields.push(field);
    }
  }
  return {
    ...latest,
    profiles: checks.map((item) => ({
      id: item.purpose,
      tools: item.tools,
      suffixes: item.features,
      promptGuard: item.promptGuard,
      shadowOutcome: item.shadowOutcome,
      shadowMaxIterations: item.shadowMaxIterations,
      latencyMs: item.latencyMs,
      reasoningEffort: item.reasoningEffort,
      contentFilter: item.contentFilter,
      promptCache: item.promptCache,
      streamed: item.streamed,
      endpoint: item.endpoint,
      applicationTool: item.applicationTool ?? null,
      jsonSchema: item.jsonSchema ?? null,
      codeComputed: item.codeComputed ?? [],
      fallbackUsed: Boolean(item.fallbackUsed),
      openserv: item.openserv,
    })),
    codeComputed: fields,
    responses,
  };
}

export function plannedProof(id: ProfileId): ServProof {
  const entry = profile(id);
  return {
    purpose: id,
    modelRequested: "not_configured",
    modelReported: "not_configured",
    tools: entry.tools.map((tool) => (tool === "prompt_guard" ? "serv_prompt_guard" : "serv_shadow_agent")),
    features: entry.feature === "none" ? [] : [entry.feature],
    promptGuard: entry.tools.includes("prompt_guard") ? "not_configured" : "not_used",
    shadowOutcome: entry.tools.includes("shadow") ? "not_configured" : "not_used",
    shadowMaxIterations: entry.shadowMaxIterations ?? null,
    latencyMs: 0,
    reasoningEffort: entry.reasoningEffort,
    contentFilter: entry.contentFilter,
    promptCache: entry.promptCache,
    streamed: entry.stream,
    endpoint: entry.endpoint,
    applicationTool: entry.applicationTool ?? null,
    jsonSchema: entry.jsonSchema?.name ?? null,
    codeComputed: [...entry.codeComputed],
    fallbackUsed: true,
    openserv: null,
  };
}
