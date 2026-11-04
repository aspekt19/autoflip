export type ServProof = {
  purpose: string;
  modelRequested: string;
  modelReported: string;
  tools: string[];
  features: string[];
  promptGuard: string;
  shadowOutcome: string;
  shadowMaxIterations: number | null;
  latencyMs: number;
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
  return (body as { tools: Array<{ function?: { name?: string } }> }).tools
    .map((tool) => tool.function?.name)
    .filter((name): name is string => Boolean(name));
}

function featureList(model: string): string[] {
  if (/-serv-multipath/i.test(model)) return ["multipath"];
  if (/-serv-kronos/i.test(model)) return ["kronos"];
  return [];
}

function shadowMax(body: unknown): number | null {
  const tools = (body as { tools?: Array<{ function?: { name?: string; parameters?: { properties?: { max_iterations?: { default?: number } } } } }> }).tools;
  const shadow = tools?.find((tool) => tool.function?.name === "serv_shadow_agent");
  const value = shadow?.function?.parameters?.properties?.max_iterations?.default;
  return typeof value === "number" ? value : null;
}

export function interpretGuard(text: string): "allow" | "block" {
  if (/^\s*allow\b/i.test(text)) return "allow";
  return "block";
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
  };
}
