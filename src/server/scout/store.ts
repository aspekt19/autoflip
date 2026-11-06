import type { Kv } from "@/io/kv";
import type { ScoutRunResult } from "@/domain/scout";

export type ScoutRunPresentation = {
  kind: "fixture_replay" | "live_autodev";
  warning: string | null;
};

export type ScoutRunMeta = {
  inventoryMode: "replay" | "live";
  isFixture: boolean;
  paidBlockedReason: string | null;
  presentation: ScoutRunPresentation;
};

const memory = new Map<string, ScoutRunResult>();
const metaMemory = new Map<string, ScoutRunMeta>();

function key(runId: string): string {
  return `scout:run:${runId}`;
}
function metaKey(runId: string): string {
  return `scout:meta:${runId}`;
}

/**
 * Persist scout run. When kv is present, durable write must succeed before callers
 * ack idempotent success — do not swallow Kv errors (Stage1B-recovery-followon).
 */
export async function saveScoutRun(
  kv: Kv | null,
  run: ScoutRunResult,
): Promise<{ ok: true } | { ok: false; message: string }> {
  memory.set(run.runId, run);
  if (!kv) return { ok: true };
  try {
    await kv.set(key(run.runId), JSON.stringify(run));
    const verify = await kv.get(key(run.runId));
    if (!verify) {
      return { ok: false, message: "Durable scout run write did not persist (read-back empty)." };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      message:
        err instanceof Error
          ? `Durable scout run write failed: ${err.message}`
          : "Durable scout run write failed.",
    };
  }
}

export async function saveScoutMeta(kv: Kv | null, runId: string, meta: ScoutRunMeta): Promise<void> {
  metaMemory.set(runId, meta);
  if (!kv) return;
  try {
    await kv.set(metaKey(runId), JSON.stringify(meta));
  } catch {
    /* memory fallback */
  }
}

export async function loadScoutRun(kv: Kv | null, runId: string): Promise<ScoutRunResult | null> {
  const hit = memory.get(runId);
  if (hit) return hit;
  if (!kv) return null;
  try {
    const raw = await kv.get(key(runId));
    if (!raw) return null;
    return JSON.parse(raw) as ScoutRunResult;
  } catch {
    return null;
  }
}

export async function loadScoutMeta(kv: Kv | null, runId: string): Promise<ScoutRunMeta | null> {
  const hit = metaMemory.get(runId);
  if (hit) return hit;
  if (!kv) return null;
  try {
    const raw = await kv.get(metaKey(runId));
    if (!raw) return null;
    return JSON.parse(raw) as ScoutRunMeta;
  } catch {
    return null;
  }
}

/**
 * Idempotency claim/receipt lives in `./idempotency` on durable Kv only
 * (no process-local Map — that caused Memory last-write vs Kv first-wins).
 */

/** Test helper */
export function clearScoutRunMemory(): void {
  memory.clear();
  metaMemory.clear();
}
