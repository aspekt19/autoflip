import type { Kv } from "@/io/kv";
import type { ScoutRunResult } from "@/domain/scout";

const memory = new Map<string, ScoutRunResult>();

function key(runId: string): string {
  return `scout:run:${runId}`;
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

/** Test helper */
export function clearScoutRunMemory(): void {
  memory.clear();
}
