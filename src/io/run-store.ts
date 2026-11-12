import type { Kv } from "./kv";
import { isRunId, parseRunRecord, type RunRecord } from "@/domain/run";

const HISTORY_LIMIT = 40;

function runKey(id: string): string {
  return `run:${id}`;
}

function ownerKey(ownerId: string): string {
  return `runs:user:${ownerId}`;
}

export async function readRun(kv: Kv, id: string): Promise<RunRecord | null> {
  if (!isRunId(id)) return null;
  const raw = await kv.get(runKey(id));
  if (!raw) return null;
  return parseRunRecord(raw);
}

async function rememberOwner(kv: Kv, ownerId: string, id: string): Promise<void> {
  const raw = await kv.get(ownerKey(ownerId));
  let prior: string[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) prior = parsed.filter((item): item is string => typeof item === "string");
    } catch {
      prior = [];
    }
  }
  const next = [id, ...prior.filter((item) => item !== id)].slice(0, HISTORY_LIMIT);
  await kv.set(ownerKey(ownerId), JSON.stringify(next));
}

export async function listOwnerRunIds(kv: Kv, ownerId: string): Promise<string[]> {
  const raw = await kv.get(ownerKey(ownerId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string" && isRunId(item));
  } catch {
    return [];
  }
}

/** Insert a new run. Returns false when the id is already taken. */
export async function insertRun(kv: Kv, run: RunRecord): Promise<boolean> {
  const ok = await kv.setNx(runKey(run.id), JSON.stringify(run));
  if (!ok) return false;
  await rememberOwner(kv, run.ownerId, run.id);
  return true;
}

/**
 * Replace the stored JSON only when it is still the string we read.
 * Retries a few times so two pipeline steps do not drop each other.
 */
export async function updateRun(kv: Kv, id: string, change: (current: RunRecord) => RunRecord): Promise<RunRecord | null> {
  if (!isRunId(id)) return null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const raw = await kv.get(runKey(id));
    if (!raw) return null;
    const current = parseRunRecord(raw);
    if (!current) return null;
    const next = change(current);
    if (next.id !== current.id || next.ownerId !== current.ownerId) return null;
    const wrote = await kv.compareAndSwap(runKey(id), raw, JSON.stringify(next));
    if (wrote) return next;
  }
  return null;
}
