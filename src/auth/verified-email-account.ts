import type { AdapterUser } from "@auth/core/adapters";
import type { Kv } from "@/io/kv";
import { KvAdapter } from "./kv-adapter";

/** One Lemonless user per lowercased verified email (Google and email-link). */
export function canonicalAccountEmail(email: string): string | null {
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes("@") || normalized.startsWith("@") || normalized.endsWith("@")) return null;
  if (normalized.includes(" ") || normalized.length > 200) return null;
  return normalized;
}

/**
 * Find or create the durable account for a verified email.
 * The returned id is what free-check quota and credits use.
 */
export async function ensureVerifiedEmailAccount(email: string, kv: Kv): Promise<AdapterUser | null> {
  const normalized = canonicalAccountEmail(email);
  if (!normalized) return null;
  const adapter = KvAdapter(kv);
  const lockKey = `auth:email-claim:${normalized}`;
  const claimed = await kv.setNx(lockKey, "1", { ttlMs: 8000 });
  if (!claimed) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const existing = await adapter.getUserByEmail!(normalized);
      if (existing) return stampVerified(adapter, existing, normalized);
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    return adapter.getUserByEmail!(normalized);
  }
  try {
    const existing = await adapter.getUserByEmail!(normalized);
    if (existing) return stampVerified(adapter, existing, normalized);
    return adapter.createUser!({
      id: crypto.randomUUID(),
      email: normalized,
      emailVerified: new Date(),
      name: null,
      image: null,
    });
  } finally {
    await kv.delete(lockKey);
  }
}

async function stampVerified(
  adapter: ReturnType<typeof KvAdapter>,
  user: AdapterUser,
  email: string,
): Promise<AdapterUser> {
  if (user.email === email && user.emailVerified) return user;
  return adapter.updateUser!({
    id: user.id,
    email,
    emailVerified: user.emailVerified ?? new Date(),
  });
}
