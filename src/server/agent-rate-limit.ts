/**
 * Per-key per-minute rate limit for agent REST + MCP.
 * Separate from report credits / free-check quota.
 */
import type { Kv } from "@/io/kv";

export const AGENT_RATE_LIMIT_PER_MINUTE = 30;

function bucketKey(keyId: string, minute: string): string {
  return `agent:rl:${keyId}:${minute}`;
}

function utcMinute(now: Date): string {
  return now.toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
}

export type AgentRateLimitResult =
  | { ok: true; remaining: number; limit: number }
  | { ok: false; remaining: 0; limit: number; retryAfterSec: number };

/**
 * Consume one request slot for this key in the current UTC minute.
 * Uses INCR so concurrent requests cannot overshoot in-process or on Upstash.
 */
export async function consumeAgentRateLimit(
  kv: Kv,
  keyId: string,
  now = new Date(),
  limit = AGENT_RATE_LIMIT_PER_MINUTE,
): Promise<AgentRateLimitResult> {
  const minute = utcMinute(now);
  const key = bucketKey(keyId, minute);
  const used = await kv.incr(key);
  if (used > limit) {
    const secIntoMinute = now.getUTCSeconds();
    return { ok: false, remaining: 0, limit, retryAfterSec: Math.max(1, 60 - secIntoMinute) };
  }
  return { ok: true, remaining: Math.max(0, limit - used), limit };
}

/** Headers for every authenticated agent response, including 429. */
export function agentRateLimitHeaders(input: {
  limit: number;
  remaining: number;
  retryAfterSec?: number;
}): Record<string, string> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(input.limit),
    "X-RateLimit-Remaining": String(Math.max(0, input.remaining)),
  };
  if (input.retryAfterSec != null) headers["Retry-After"] = String(input.retryAfterSec);
  return headers;
}
