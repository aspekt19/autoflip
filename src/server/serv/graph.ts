/**
 * SERV Graph Sharding call path.
 *
 * A graph is called like a model on the same Responses endpoint and API key:
 * `model` is the graph's `gr_` id, the run input goes in `instructions`,
 * streaming is not supported, and no SERV feature suffix or feature tool is sent.
 * Source: console.openserv.ai Graphs docs ("Using the API", "Costs, limits and FAQ").
 *
 * Code still owns every number: the run input is a fact sheet code already computed,
 * and callers validate the answer with the same validators as the two-call path.
 */
import { classifyServTransportError, type ServTransportErrorClass } from "./transport-error";
import { messageText, servApiBase, servErrorSummary } from "./run";

export const GRAPH_REQUEST_ID_HEADER = "x-openserv-request-id";

/** One recorded step of a graph run, when the provider returns one. */
export type GraphStepTrailItem = {
  id: string | null;
  kind: string | null;
  status: string | null;
};

export type GraphRunMeta = {
  graphId: string;
  /** Run id from the `x-openserv-request-id` header (links to the console Runs panel). */
  runId: string | null;
  /** Provider response id from the body, when present. */
  responseId: string | null;
  /**
   * Step trail returned in the body. The public docs do not specify a body field for it;
   * we record it only when one of the known-shaped arrays is present. Null means
   * "not returned in the response"; the full trail is in the console by runId.
   */
  steps: GraphStepTrailItem[] | null;
  durationMs: number;
  httpStatus: number | null;
  usage: Record<string, unknown> | null;
};

export type GraphRunResult =
  | { ok: true; text: string; payload: unknown; meta: GraphRunMeta }
  | {
      ok: false;
      error: string;
      transportErrorClass: ServTransportErrorClass | "tool_call" | "empty";
      payload: unknown;
      meta: GraphRunMeta;
    };

export type GraphDeps = {
  fetch?: typeof fetch;
  apiKey: string;
  baseUrl?: string;
  timeoutMs: number;
};

/** True when a string looks like a SERV graph id. */
export function isGraphId(value: string | null | undefined): value is string {
  return typeof value === "string" && /^gr_[A-Za-z0-9_-]+$/.test(value.trim());
}

/** Read the configured Find decide graph id. Empty / malformed → null (graph path off). */
export function findDecideGraphId(env: Record<string, string | undefined> = process.env): string | null {
  const raw = env.SERV_GRAPH_FIND_DECIDE_ID?.trim();
  return isGraphId(raw) ? raw : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Best-effort step trail from a graph response body. Never invents steps. */
export function extractGraphTrail(payload: unknown): GraphStepTrailItem[] | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const metadata =
    record.metadata && typeof record.metadata === "object"
      ? (record.metadata as Record<string, unknown>)
      : {};
  const candidates = [record.steps, record.graph_steps, record.visits, metadata.steps, metadata.visits];
  const rows = candidates.find((value) => Array.isArray(value)) as unknown[] | undefined;
  if (!rows) return null;
  return rows
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
    .slice(0, 50)
    .map((row) => ({
      id: str(row.id) ?? str(row.step_id) ?? str(row.stepId) ?? str(row.name),
      kind: str(row.kind) ?? str(row.type),
      status: str(row.status),
    }));
}

function hasFunctionCall(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const output = (payload as { output?: unknown }).output;
  return Array.isArray(output) && output.some((item) => (item as { type?: unknown })?.type === "function_call");
}

/**
 * Run a SERV graph once. The Find decide graph uses no application tools, so a
 * `function_call` pause is treated as a failure (the caller falls back).
 */
export async function runServGraph(input: {
  graphId: string;
  instructions: string;
  deps: GraphDeps;
}): Promise<GraphRunResult> {
  const started = Date.now();
  const meta: GraphRunMeta = {
    graphId: input.graphId,
    runId: null,
    responseId: null,
    steps: null,
    durationMs: 0,
    httpStatus: null,
    usage: null,
  };
  const doFetch = input.deps.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, input.deps.timeoutMs));
  try {
    const res = await doFetch(`${servApiBase(input.deps.baseUrl)}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.deps.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: input.graphId, instructions: input.instructions }),
      signal: controller.signal,
    });
    meta.httpStatus = res.status;
    meta.runId = str(res.headers?.get?.(GRAPH_REQUEST_ID_HEADER));
    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    meta.durationMs = Date.now() - started;
    const body = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
    meta.responseId = str(body.id);
    meta.steps = extractGraphTrail(payload);
    meta.usage = body.usage && typeof body.usage === "object" ? (body.usage as Record<string, unknown>) : null;
    if (!res.ok) {
      return {
        ok: false,
        error: servErrorSummary(payload) || `graph HTTP ${res.status}`,
        transportErrorClass: res.status >= 500 ? "http_5xx" : "http_4xx",
        payload,
        meta,
      };
    }
    if (hasFunctionCall(payload)) {
      return {
        ok: false,
        error: "graph paused for a tool call; the Find decide graph has no tools",
        transportErrorClass: "tool_call",
        payload,
        meta,
      };
    }
    const text = messageText(payload, "structured");
    if (!text) {
      return { ok: false, error: "graph returned no text", transportErrorClass: "empty", payload, meta };
    }
    return { ok: true, text, payload, meta };
  } catch (err) {
    meta.durationMs = Date.now() - started;
    const classified = classifyServTransportError(err);
    return {
      ok: false,
      error: controller.signal.aborted ? "graph call timed out waiting for a response." : classified.detail,
      transportErrorClass: controller.signal.aborted ? "timeout" : classified.class,
      payload: null,
      meta,
    };
  } finally {
    clearTimeout(timer);
  }
}
