/**
 * Shared-store gate for paid Autodev dispatch (/find and related).
 * Env storageMode alone is not proof — inspect the actual Kv backend.
 * Serverless (Vercel) without Upstash must fail closed BEFORE upstream HTTP.
 * Local file Kv is allowed for offline/dev; Memory on Vercel is not a monthly cap.
 *
 * Stage1 follow-on for /find (separate from scout paid-execution authority).
 */
import type { Kv } from "@/io/kv";
import { isDistributedQuotaBackend, kvBackendOf } from "@/io/kv";

export type PaidDispatchGuardResult =
  | { ok: true }
  | {
      ok: false;
      error: "quota_backend_not_distributed";
      message: string;
    };

export function requireSharedQuotaForPaidDispatch(input: {
  kv: Kv;
  /** When true (Vercel / forced), Memory/File are rejected. */
  serverless: boolean;
}): PaidDispatchGuardResult {
  if (!input.serverless) return { ok: true };
  if (isDistributedQuotaBackend(input.kv)) return { ok: true };
  return {
    ok: false,
    error: "quota_backend_not_distributed",
    message: `Paid listing lookup blocked: Kv backend is ${kvBackendOf(input.kv)} on serverless. A persistent shared store (Upstash) is required before Autodev upstream. Env storageMode alone is not proof.`,
  };
}

export function isServerlessRuntime(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.VERCEL?.trim()) || env.FIND_REQUIRE_SHARED_QUOTA === "1" || env.FIND_REQUIRE_SHARED_QUOTA === "true";
}
