/**
 * Authenticate an af_ agent request: key → account → scopes → rate limit.
 */
import type { Kv } from "@/io/kv";
import { resolveApiKeyRecord } from "./api-keys";
import {
  agentError,
  invalidKeyEnvelope,
  jsonError,
  rateLimitedEnvelope,
  type AgentErrorEnvelope,
} from "./agent-envelope";
import { consumeAgentRateLimit } from "./agent-rate-limit";
import { scopeAllows, scopeDenial, type AgentScope } from "./agent-scopes";
import { bearer } from "./secrets";

export type AgentCaller = {
  userId: string;
  keyId: string;
  keyPrefix: string;
  keyHash: string;
  scopes: AgentScope[];
  token: string;
};

export type AgentAuthResult =
  | { ok: true; caller: AgentCaller }
  | { ok: false; status: number; body: AgentErrorEnvelope };

export async function authenticateAgentRequest(
  kv: Kv,
  request: Request,
  origin: string,
  neededScope: AgentScope,
): Promise<AgentAuthResult> {
  const token = bearer(request);
  if (!token || !token.startsWith("af_")) {
    return {
      ok: false,
      status: 401,
      body: agentError({
        error_code: "auth_required",
        message: "Send Authorization: Bearer af_… from /developers.",
        credit_spent: false,
        retry_safe: false,
        next_steps: {
          action: "create_api_key",
          summary: `Create a key at ${origin}/developers and retry with Authorization: Bearer af_….`,
          request: {
            method: "POST",
            url: `${origin}/api/agents/keys`,
            body: { label: "Agent key", scopes: ["read", "check", "find"] },
          },
          docs: `${origin}/developers`,
        },
      }),
    };
  }
  const record = await resolveApiKeyRecord(kv, token);
  if (!record) {
    return { ok: false, status: 401, body: invalidKeyEnvelope(origin) };
  }
  if (!scopeAllows(record.scopes, neededScope)) {
    return { ok: false, status: 403, body: scopeDenial(neededScope, origin) };
  }
  const rate = await consumeAgentRateLimit(kv, record.id);
  if (!rate.ok) {
    return { ok: false, status: 429, body: rateLimitedEnvelope(origin, rate.retryAfterSec) };
  }
  return {
    ok: true,
    caller: {
      userId: record.userId,
      keyId: record.id,
      keyPrefix: record.prefix,
      keyHash: record.hash,
      scopes: record.scopes,
      token,
    },
  };
}

export function authFailureResponse(result: Extract<AgentAuthResult, { ok: false }>): Response {
  const headers =
    result.status === 429
      ? { "Retry-After": String(result.body.next_steps.request.body?.retryAfterSec ?? 60) }
      : undefined;
  return jsonError(result.status, result.body, headers);
}
