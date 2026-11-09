import type { AdapterUser } from "@auth/core/adapters";
import type { Kv } from "@/io/kv";
import { canonicalAccountEmail } from "./email-address";
import { KvAdapter } from "./kv-adapter";

export { canonicalAccountEmail } from "./email-address";

/**
 * Find or create the durable account for a verified email.
 * The returned id is what free-check quota and credits use.
 * createUser is idempotent per email, so Google and email-link cannot mint a second id.
 */
export async function ensureVerifiedEmailAccount(email: string, kv: Kv): Promise<AdapterUser | null> {
  const normalized = canonicalAccountEmail(email);
  if (!normalized) return null;
  const adapter = KvAdapter(kv);
  const existing = await adapter.getUserByEmail!(normalized);
  if (existing?.email === normalized && existing.emailVerified) return existing;
  if (existing) return stampVerified(adapter, existing, normalized);
  try {
    const created = await adapter.createUser!({
      id: crypto.randomUUID(),
      email: normalized,
      emailVerified: new Date(),
      name: null,
      image: null,
    });
    if (created.email === normalized && created.emailVerified) return created;
    return stampVerified(adapter, created, normalized);
  } catch {
    const raced = await adapter.getUserByEmail!(normalized);
    return raced ? stampVerified(adapter, raced, normalized) : null;
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
