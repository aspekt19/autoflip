/**
 * Agent error / next_steps envelope (credits, not USDC).
 * Every agent 4xx/5xx should use this shape.
 */

export type AgentNextStepRequest = {
  method: string;
  url?: string;
  /** MCP tool name when the next step is tools/call. */
  name?: string;
  body?: Record<string, unknown>;
  arguments?: Record<string, unknown>;
  headers?: Record<string, string>;
};

export type AgentNextSteps = {
  action: string;
  summary: string;
  request: AgentNextStepRequest;
  docs?: string;
  openapi?: string;
  discovery?: string;
};

export type AgentErrorEnvelope = {
  error_code: string;
  message: string;
  credit_spent: boolean;
  retry_safe: boolean;
  next_steps: AgentNextSteps;
  /** Legacy alias kept for older clients. */
  error?: string;
  next_action?: string;
};

export function agentError(input: {
  error_code: string;
  message: string;
  credit_spent?: boolean;
  retry_safe?: boolean;
  next_steps: AgentNextSteps;
}): AgentErrorEnvelope {
  return {
    error_code: input.error_code,
    error: input.error_code,
    message: input.message,
    credit_spent: input.credit_spent ?? false,
    retry_safe: input.retry_safe ?? false,
    next_steps: input.next_steps,
    next_action: input.next_steps.summary,
  };
}

export function insufficientCreditsEnvelope(origin: string, balance = 0): AgentErrorEnvelope {
  return agentError({
    error_code: "insufficient_credits",
    message: "This account has no report credits left. The analysis was not run.",
    credit_spent: false,
    retry_safe: true,
    next_steps: {
      action: "buy_credits_then_retry",
      summary: `Buy credits at ${origin}/credits, then retry with the same API key and Idempotency-Key.`,
      request: { method: "GET", url: `${origin}/credits` },
      docs: `${origin}/developers`,
      openapi: `${origin}/openapi.json`,
      discovery: `${origin}/.well-known/agent.json`,
    },
  });
}

export function invalidKeyEnvelope(origin: string): AgentErrorEnvelope {
  return agentError({
    error_code: "invalid_key",
    message: "That API key is missing or revoked.",
    credit_spent: false,
    retry_safe: false,
    next_steps: {
      action: "create_api_key",
      summary: `Create a new key on ${origin}/developers.`,
      request: {
        method: "POST",
        url: `${origin}/api/agents/keys`,
        body: { label: "Agent key", scopes: ["read", "check", "find"] },
      },
      docs: `${origin}/developers`,
    },
  });
}

export function rateLimitedEnvelope(origin: string, retryAfterSec: number): AgentErrorEnvelope {
  return agentError({
    error_code: "rate_limited",
    message: `Too many requests for this API key. Retry in about ${retryAfterSec} seconds.`,
    credit_spent: false,
    retry_safe: true,
    next_steps: {
      action: "wait_and_retry",
      summary: `Wait ${retryAfterSec}s, then retry the same request with the same Idempotency-Key.`,
      request: { method: "GET", url: `${origin}/.well-known/agent.json` },
      docs: `${origin}/developers`,
    },
  });
}

export function jsonError(status: number, body: AgentErrorEnvelope, headers?: HeadersInit): Response {
  return Response.json(body, { status, headers });
}
