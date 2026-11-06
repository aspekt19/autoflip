import { storageMode, type StorageMode } from "./kv";

/**
 * Money and auth state must not use ephemeral MemoryKv or local file store
 * on Vercel / production. Local file mode remains allowed for offline dev only.
 */
export function moneyAuthStorageOk(
  env: Record<string, string | undefined> = process.env,
  mode: StorageMode = storageMode(env),
): boolean {
  const hosted = Boolean(env.VERCEL) || env.NODE_ENV === "production" || env.VERCEL_ENV === "production" || env.VERCEL_ENV === "preview";
  if (!hosted) return true;
  return mode === "upstash";
}

export function moneyAuthStoreFailure(): Response {
  return Response.json(
    {
      error: "money_store_unconfigured",
      message:
        "Persistent Upstash KV is required for authentication and paid credits on this host. File/memory fallback is refused.",
    },
    { status: 503 },
  );
}

export function requireMoneyAuthStore(
  env: Record<string, string | undefined> = process.env,
): { ok: true } | { ok: false; response: Response } {
  if (moneyAuthStorageOk(env)) return { ok: true };
  return { ok: false, response: moneyAuthStoreFailure() };
}
