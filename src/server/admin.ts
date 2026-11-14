import { KvAdapter } from "@/auth/kv-adapter";
import type { Kv } from "@/io/kv";

function normalizedEmail(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** Admin access is tied to a verified account email, never to client input. */
export function isAdminEmail(
  email: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const candidate = normalizedEmail(email);
  if (!candidate) return false;
  const allowlist = (env.LEMONLESS_ADMIN_EMAILS ?? "")
    .split(",")
    .map((value) => normalizedEmail(value))
    .filter(Boolean);
  return allowlist.includes(candidate);
}

/** API-key owners inherit admin only from their verified Auth.js account record. */
export async function isAdminUser(kv: Kv, userId: string): Promise<boolean> {
  if (!userId.trim()) return false;
  const user = await KvAdapter(kv).getUser?.(userId);
  return Boolean(user?.emailVerified && isAdminEmail(user.email));
}
