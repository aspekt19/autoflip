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

export async function saveScoutRun(kv: Kv | null, run: ScoutRunResult): Promise<void> {
  memory.set(run.runId, run);
  if (!kv) return;
  try {
    await kv.set(key(run.runId), JSON.stringify(run));
  } catch {
    /* memory fallback only */
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

/** Test helper */
export function clearScoutRunMemory(): void {
  memory.clear();
  metaMemory.clear();
}
