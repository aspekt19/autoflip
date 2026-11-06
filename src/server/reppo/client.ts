/**
 * Reppo Evaluation API client for an isolated AutoFlip proof of concept.
 *
 * This module is deliberately not wired into report assembly or production routes.
 * The API key must be supplied by a server-side caller; never pass it to the browser.
 */

export type ReppoEvaluationType = "answer" | "plan" | "trace" | "artifact";
export type ReppoSettlementMinutes = 10 | 15 | 30;

export type ReppoSubmitInput = {
  apiKey: string;
  type: ReppoEvaluationType;
  payload: string;
  context?: string;
  settlementMinutes?: ReppoSettlementMinutes;
  fetch?: typeof fetch;
};

export type ReppoGetInput = {
  apiKey: string;
  evalId: string;
  fetch?: typeof fetch;
};

const REPPO_BASE_URL = "https://eval.reppo.xyz/api/v1/agents/eval-requests";

function requireApiKey(apiKey: string): void {
  if (!apiKey.trim()) throw new Error("REPPO_API_KEY is required.");
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text.slice(0, 2_000) };
  }
}

async function requestJson(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(20_000),
  });
  const body = await readJson(response);
  if (!response.ok) {
    const detail =
      typeof body === "string"
        ? body.slice(0, 1_500)
        : JSON.stringify(body)?.slice(0, 1_500) ?? "empty response body";
    const requestId =
      response.headers.get("x-request-id") ??
      response.headers.get("cf-ray") ??
      response.headers.get("x-correlation-id");
    const contentType = response.headers.get("content-type") ?? "unknown";
    throw new Error(
      `Reppo Evaluation API request failed: HTTP ${response.status} ${response.statusText}; URL ${url}; content-type ${contentType}; request-id ${requestId ?? "unavailable"}; response ${detail}`,
    );
  }
  return body;
}

/** Submit one report/trace for independent evaluation. The response is kept raw
 * because the provider's full response schema may evolve; callers must validate it.
 */
export async function submitReppoEvaluation(input: ReppoSubmitInput): Promise<unknown> {
  requireApiKey(input.apiKey);
  if (!input.payload.trim()) throw new Error("Reppo payload must not be empty.");
  if (new TextEncoder().encode(input.payload).byteLength > 50 * 1024) {
    throw new Error("Reppo payload exceeds the documented 50 KB limit.");
  }

  const fetchImpl = input.fetch ?? fetch;
  return requestJson(
    `${REPPO_BASE_URL}/submit`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: input.type,
        payload: input.payload,
        ...(input.context ? { context: input.context } : {}),
        settlementMinutes: input.settlementMinutes ?? 10,
      }),
    },
    fetchImpl,
  );
}

/** Retrieve a settled or pending evaluation by the evalId returned by Reppo. */
export async function getReppoEvaluation(input: ReppoGetInput): Promise<unknown> {
  requireApiKey(input.apiKey);
  if (!input.evalId.trim()) throw new Error("Reppo evalId is required.");
  const fetchImpl = input.fetch ?? fetch;
  return requestJson(
    `${REPPO_BASE_URL}/${encodeURIComponent(input.evalId)}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${input.apiKey}` },
    },
    fetchImpl,
  );
}
