/**
 * Cross-instance scout idempotency — claim BEFORE work.
 *
 * Storage: durable SET NX on the actual Kv backend (Upstash in production).
 * Process-local Maps are NOT used for claims (that caused Memory last-write vs Kv first-wins).
 * Credit-lock TTL ≠ durable receipt — receipts and in_progress claims are durable (no PX).
 * Stuck in_progress after crash: return in_progress; do NOT re-execute expensive work.
 *
 * Hash binds stripped mandate + effective request intent (planner, preferLive).
 * Client spend/budget fields stay stripped — they never authorize and must not fork the key.
 * planner/preferLive change result meaning (replay vs live inventory; heuristic vs SERV) so
 * they are included; silent replay across different intent is forbidden.
 *
 * Stage1B-recovery (queued): if complete receipt kv.set fails after run, claim can stick
 * in_progress forever. Prefer recover completed run by claim-owned runId reference — never
 * re-execute; uncertain claims stay non-executing + recovery_needed.
 */

import { createHash } from "node:crypto";
import type { Kv } from "@/io/kv";
import { isDistributedQuotaBackend } from "@/io/kv";
import type { ScoutRunResult } from "@/domain/scout";
import { isServerlessRuntime } from "@/server/paid-dispatch-guard";

export type ScoutIdemReceipt = {
  status: "completed";
  ownerId: string;
  mandateHash: string;
  result: ScoutRunResult;
  inventoryMode: "replay" | "live";
  isFixture: boolean;
  paidBlockedReason: string | null;
  completedAt: string;
};

export type ScoutIdemClaim = {
  status: "in_progress";
  ownerId: string;
  mandateHash: string;
  claimedAt: string;
};

export type ScoutIdemRecord = ScoutIdemReceipt | ScoutIdemClaim;

export type IdemClaimResult =
  | { kind: "proceed"; recordKey: string; mandateHash: string }
  | { kind: "replay"; receipt: ScoutIdemReceipt }
  | { kind: "in_progress"; mandateHash: string }
  | { kind: "conflict"; existingHash: string; requestedHash: string }
  | { kind: "backend_required"; message: string };

function idemRecordKey(ownerId: string, clientKey: string): string {
  return `scout:idem:v2:${ownerId}:${clientKey}`;
}

export type ScoutIdemIntent = {
  /** Effective planner mode for this request (server-interpreted). */
  planner?: string | null;
  /** Effective preferLive for this request (server-interpreted). */
  preferLive?: boolean;
};

/**
 * Stable hash binding Idempotency-Key to mandate body + effective intent.
 * Spend/budget client fields stripped. planner/preferLive included (result meaning).
 */
export function canonicalMandateHash(mandate: unknown, intent?: ScoutIdemIntent): string {
  const normalized = {
    mandate: normalizeForHash(mandate),
    planner: intent?.planner?.trim() || "offline_heuristic",
    preferLive: Boolean(intent?.preferLive),
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

/** Same client spend/budget keys as stripClientSpendClaims — must not bind the idempotency lock. */
const HASH_STRIP_KEYS = new Set([
  "verifiedBalanceUsd",
  "hardCapUsd",
  "minReserveUsd",
  "attestationId",
  "attestedAt",
  "spendAuth",
  "authorizedSpendUsd",
  "maxProviderCalls",
  "maxServCalls",
  "maxToolCalls",
  "maxWallMs",
  "SCOUT_VERIFIED_BALANCE_USD",
  "SCOUT_SPEND_HARD_CAP_USD",
  "SCOUT_SERVER_VERIFIED_BALANCE_USD",
  "SCOUT_SERVER_SPEND_HARD_CAP_USD",
  "testAuthority",
  "budgets",
]);

function normalizeForHash(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value ?? null;
  if (Array.isArray(value)) return value.map(normalizeForHash);
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (HASH_STRIP_KEYS.has(k) || k.startsWith("SCOUT_")) continue;
    out[k] = normalizeForHash(obj[k]);
  }
  return out;
}

function parseRecord(raw: string): ScoutIdemRecord | null {
  try {
    const parsed = JSON.parse(raw) as ScoutIdemRecord;
    if (parsed?.status === "completed" || parsed?.status === "in_progress") return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * Atomic claim before any scout/provider work.
 * Requires distributed Kv on serverless when an Idempotency-Key is present.
 */
export async function claimScoutIdempotency(input: {
  kv: Kv;
  ownerId: string;
  clientKey: string;
  mandate: unknown;
  /** Effective planner/preferLive — must match for replay; excluded spend fields never go here. */
  intent?: ScoutIdemIntent;
  env?: Record<string, string | undefined>;
}): Promise<IdemClaimResult> {
  const serverless = isServerlessRuntime(input.env ?? process.env);
  if (serverless && !isDistributedQuotaBackend(input.kv)) {
    return {
      kind: "backend_required",
      message: `Idempotent scout requires Upstash Kv on serverless (backend=${input.kv.backend}). Process-local Memory is not a cross-instance claim store.`,
    };
  }

  const mandateHash = canonicalMandateHash(input.mandate, input.intent);
  const recordKey = idemRecordKey(input.ownerId, input.clientKey);

  const existingRaw = await input.kv.get(recordKey);
  if (existingRaw) {
    const existing = parseRecord(existingRaw);
    if (!existing) {
      // Corrupt — fail closed, do not overwrite (may have dispatched).
      return { kind: "in_progress", mandateHash: "corrupt" };
    }
    if (existing.mandateHash !== mandateHash) {
      return {
        kind: "conflict",
        existingHash: existing.mandateHash,
        requestedHash: mandateHash,
      };
    }
    if (existing.status === "completed") {
      return { kind: "replay", receipt: existing };
    }
    // Same body, still in progress — do not start a second execution.
    return { kind: "in_progress", mandateHash };
  }

  const claim: ScoutIdemClaim = {
    status: "in_progress",
    ownerId: input.ownerId,
    mandateHash,
    claimedAt: new Date().toISOString(),
  };
  // Durable SET NX — no PX (receipt/claim ≠ credit-lock TTL).
  const won = await input.kv.setNx(recordKey, JSON.stringify(claim));
  if (!won) {
    const raced = await input.kv.get(recordKey);
    const record = raced ? parseRecord(raced) : null;
    if (!record) return { kind: "in_progress", mandateHash };
    if (record.mandateHash !== mandateHash) {
      return {
        kind: "conflict",
        existingHash: record.mandateHash,
        requestedHash: mandateHash,
      };
    }
    if (record.status === "completed") return { kind: "replay", receipt: record };
    return { kind: "in_progress", mandateHash };
  }
  return { kind: "proceed", recordKey, mandateHash };
}

/** Durable completed receipt — overwrites in_progress. Never TTL. */
export async function completeScoutIdempotency(
  kv: Kv,
  recordKey: string,
  receipt: Omit<ScoutIdemReceipt, "status" | "completedAt">,
): Promise<void> {
  const full: ScoutIdemReceipt = {
    ...receipt,
    status: "completed",
    completedAt: new Date().toISOString(),
  };
  await kv.set(recordKey, JSON.stringify(full));
}

export function idemRecordKeyForTest(ownerId: string, clientKey: string): string {
  return idemRecordKey(ownerId, clientKey);
}
