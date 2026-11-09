import type { Kv } from "@/io/kv";

type Window = { count: number; resetAt: number };

/**
 * Fixed-window rate limiter stored in KV.
 * Returns false when the caller should be rejected.
 */
export async function consumeRateLimit(
  kv: Kv,
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): Promise<{ ok: boolean; remaining: number; resetAt: number }> {
  const raw = await kv.get(key);
  let window: Window = { count: 0, resetAt: now + windowMs };
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Window;
      if (typeof parsed.count === "number" && typeof parsed.resetAt === "number" && parsed.resetAt > now) {
        window = parsed;
      }
    } catch {
      /* start fresh */
    }
  }
  if (window.count >= limit) {
    return { ok: false, remaining: 0, resetAt: window.resetAt };
  }
  window.count += 1;
  await kv.set(key, JSON.stringify(window));
  return { ok: true, remaining: Math.max(0, limit - window.count), resetAt: window.resetAt };
}

export function emailSignInRateKey(email: string, ip: string): string {
  const normalized = email.trim().toLowerCase();
  return `auth:rate:email:${normalized}:${ip || "unknown"}`;
}
