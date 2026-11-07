/**
 * Cross-instance scout idempotency — claim BEFORE work.
 *
 * Storage: durable SET NX on the actual Kv backend (Upstash in production).
 * Process-local Maps are NOT used for claims (that caused Memory last-write vs Kv first-wins).
 * Credit-lock TTL ≠ durable receipt — receipts and in_progress claims are durable (no PX).
 * Never auto-reclaim / re-execute expensive work.
 *
 * Hash binds stripped mandate + effective request intent (planner, preferLive).
 * Client spend/budget fields stay stripped.
 *
 * Stage1B-recovery (minimal):
 * After run completes, bind claim-owned runId (+ inventory flags) onto the in_progress claim,
 * then write the completed receipt. If receipt write fails, a later claim loads the run by
 * runId (ownership-checked) and finishes the receipt — no provider/planner re-exec.
 * No runId yet → honest in_progress (active overlap; not false-dead).
 * Bound runId but missing durable run / owner mismatch / receipt write fail → recovery_needed.
 * Never TTL reclaim / never re-exec expensive work.
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
  /** Bound after run completes + run row persisted — enables receipt reconcile without re-exec. */
  runId?: string;
  inventoryMode?: "replay" | "live";
  isFixture?: boolean;
  paidBlockedReason?: string | null;
};

export type ScoutIdemRecord = ScoutIdemReceipt | ScoutIdemClaim;

export type IdemClaimResult =
  | { kind: "proceed"; recordKey: string; mandateHash: string }
  | { kind: "replay"; receipt: ScoutIdemReceipt }
  | { kind: "in_progress"; mandateHash: string }
  | {
      kind: "recovery_needed";
      mandateHash: string;
      reason: string;
    }
  | { kind: "conflict"; existingHash: string; requestedHash: string }
  | { kind: "backend_required"; message: string };

function idemRecordKey(ownerId: string, clientKey: string): string {
  return `scout:idem:v2:${ownerId}:${clientKey}`;
}

function runStorageKey(runId: string): string {
  return `scout:run:${runId}`;
}

export type ScoutIdemIntent = {
  planner?: string | null;
  preferLive?: boolean;
};

export function canonicalMandateHash(mandate: unknown, intent?: ScoutIdemIntent): string {
  const normalized = {
    mandate: normalizeForHash(mandate),
    planner: intent?.planner?.trim() || "offline_heuristic",
    preferLive: Boolean(intent?.preferLive),
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

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

/** Durable-only run load (no process Map) — required for restart / different facade reconcile. */
export async function loadDurableScoutRun(kv: Kv, runId: string): Promise<ScoutRunResult | null> {
  try {
    const raw = await kv.get(runStorageKey(runId));
    if (!raw) return null;
    return JSON.parse(raw) as ScoutRunResult;
  } catch {
    return null;
  }
}

/**
 * Try to finish a stuck in_progress claim from a claim-owned runId.
 * Never re-executes provider/planner. Ownership + mandateHash must match.
 */
export async function reconcileScoutIdempotencyClaim(input: {
  kv: Kv;
  recordKey: string;
  ownerId: string;
  mandateHash: string;
  claim: ScoutIdemClaim;
}): Promise<IdemClaimResult> {
  const { claim } = input;
  if (claim.ownerId !== input.ownerId) {
    return {
      kind: "recovery_needed",
      mandateHash: input.mandateHash,
      reason: "Claim owner mismatch — refusing foreign exposure and refusing re-exec.",
    };
  }
  if (claim.mandateHash !== input.mandateHash) {
    return {
      kind: "conflict",
      existingHash: claim.mandateHash,
      requestedHash: input.mandateHash,
    };
  }
  if (!claim.runId) {
    // Active overlap OR abandoned mid-claim — not proven dead. Honest non-terminal in_progress.
    // No TTL/heartbeat: do not declare recovery_needed (falsely dead) while owner may still finish.
    return {
      kind: "in_progress",
      mandateHash: input.mandateHash,
    };
  }

  const run = await loadDurableScoutRun(input.kv, claim.runId);
  if (!run) {
    // Bound runId but no durable row — persist failed or lost; not re-executing.
    return {
      kind: "recovery_needed",
      mandateHash: input.mandateHash,
      reason: `Claim references runId ${claim.runId} but no durable run row was found — persist uncertain; not re-executing.`,
    };
  }
  if (run.ownerId !== input.ownerId) {
    return {
      kind: "recovery_needed",
      mandateHash: input.mandateHash,
      reason: "Durable run owner mismatch — refusing foreign exposure and refusing re-exec.",
    };
  }

  const receipt: ScoutIdemReceipt = {
    status: "completed",
    ownerId: input.ownerId,
    mandateHash: input.mandateHash,
    result: run,
    inventoryMode: claim.inventoryMode ?? (run.inventorySource === "live" ? "live" : "replay"),
    isFixture: claim.isFixture ?? run.inventorySource === "replay",
    paidBlockedReason: claim.paidBlockedReason ?? null,
    completedAt: new Date().toISOString(),
  };
  try {
    await input.kv.set(input.recordKey, JSON.stringify(receipt));
  } catch {
    return {
      kind: "recovery_needed",
      mandateHash: input.mandateHash,
      reason: "Found durable run but could not write completed receipt — recovery_needed; not re-executing.",
    };
  }
  return { kind: "replay", receipt };
}

async function resolveExistingRecord(
  kv: Kv,
  recordKey: string,
  ownerId: string,
  mandateHash: string,
  existing: ScoutIdemRecord,
): Promise<IdemClaimResult> {
  if (existing.mandateHash !== mandateHash) {
    return {
      kind: "conflict",
      existingHash: existing.mandateHash,
      requestedHash: mandateHash,
    };
  }
  if (existing.status === "completed") {
    if (existing.ownerId !== ownerId) {
      return {
        kind: "recovery_needed",
        mandateHash,
        reason: "Completed receipt owner mismatch — refusing foreign exposure.",
      };
    }
    return { kind: "replay", receipt: existing };
  }
  // in_progress — attempt claim-owned run reconcile; never re-exec.
  return reconcileScoutIdempotencyClaim({
    kv,
    recordKey,
    ownerId,
    mandateHash,
    claim: existing,
  });
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
      return {
        kind: "recovery_needed",
        mandateHash: "corrupt",
        reason: "Corrupt idempotency record — fail closed; not re-executing.",
      };
    }
    return resolveExistingRecord(input.kv, recordKey, input.ownerId, mandateHash, existing);
  }

  const claim: ScoutIdemClaim = {
    status: "in_progress",
    ownerId: input.ownerId,
    mandateHash,
    claimedAt: new Date().toISOString(),
  };
  const won = await input.kv.setNx(recordKey, JSON.stringify(claim));
  if (!won) {
    const raced = await input.kv.get(recordKey);
    const record = raced ? parseRecord(raced) : null;
    if (!record) {
      return {
        kind: "recovery_needed",
        mandateHash,
        reason: "Lost claim race and record unreadable — not re-executing.",
      };
    }
    return resolveExistingRecord(input.kv, recordKey, input.ownerId, mandateHash, record);
  }
  return { kind: "proceed", recordKey, mandateHash };
}

/**
 * Bind claim-owned runId after durable run persist, before completed receipt.
 * Leaves status in_progress so a failed receipt write remains recoverable.
 */
export async function bindScoutIdempotencyRun(
  kv: Kv,
  recordKey: string,
  bind: {
    ownerId: string;
    mandateHash: string;
    runId: string;
    inventoryMode: "replay" | "live";
    isFixture: boolean;
    paidBlockedReason: string | null;
  },
): Promise<void> {
  const raw = await kv.get(recordKey);
  const existing = raw ? parseRecord(raw) : null;
  if (!existing || existing.status !== "in_progress") {
    throw new Error("bindScoutIdempotencyRun: expected in_progress claim");
  }
  if (existing.ownerId !== bind.ownerId || existing.mandateHash !== bind.mandateHash) {
    throw new Error("bindScoutIdempotencyRun: ownership/mandate mismatch");
  }
  const next: ScoutIdemClaim = {
    ...existing,
    runId: bind.runId,
    inventoryMode: bind.inventoryMode,
    isFixture: bind.isFixture,
    paidBlockedReason: bind.paidBlockedReason,
  };
  await kv.set(recordKey, JSON.stringify(next));
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
