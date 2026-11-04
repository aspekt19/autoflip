import type { Kv } from "@/io/kv";
import type { SavedSearch, WatchAlert } from "@/domain/radar-watch";
import { demoPresets } from "@/domain/demo-presets";
import { DEMO_USER_ID } from "@/domain/radar-watch";
import { creditSet } from "@/io/credit-book";

const SEARCHES = "radar:searches";
const ALERTS = "radar:alerts";
const RUNS = "radar:runs";
const CHECK_NOW = "radar:check-now";

async function readJson<T>(kv: Kv, key: string, fallback: T): Promise<T> {
  const raw = await kv.get(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function listSearches(kv: Kv): Promise<SavedSearch[]> {
  return readJson<SavedSearch[]>(kv, SEARCHES, []);
}

export async function saveSearches(kv: Kv, rows: SavedSearch[]): Promise<void> {
  await kv.set(SEARCHES, JSON.stringify(rows));
}

export async function listAlerts(kv: Kv): Promise<WatchAlert[]> {
  return readJson<WatchAlert[]>(kv, ALERTS, []);
}

export async function saveAlerts(kv: Kv, rows: WatchAlert[]): Promise<void> {
  await kv.set(ALERTS, JSON.stringify(rows.slice(0, 80)));
}

export async function seenVins(kv: Kv, criteriaHash: string): Promise<Set<string>> {
  const rows = await readJson<string[]>(kv, `radar:seen:${criteriaHash}`, []);
  return new Set(rows);
}

export async function storeSeen(kv: Kv, criteriaHash: string, vins: string[]): Promise<void> {
  await kv.set(`radar:seen:${criteriaHash}`, JSON.stringify(vins.slice(-2000)));
}

export type StoredRun = {
  id: string;
  startedAt: string;
  finishedAt: string;
  trigger: "cron" | "check_now";
  storage: string;
  uniqueSearches: number;
  intervalHours: number;
  listings: number;
  passed: number;
  filteredOut: number;
  alertsSent: number;
  autodevCalls: number;
  skippedDue: number;
  notes: string[];
  serv: { promptGuard: string; shadow: string };
  payment: {
    status: string;
    missing: string[];
    tx: string | null;
    detail: string;
    costAtomic: string | null;
    network: string | null;
  };
};

export async function listRuns(kv: Kv): Promise<StoredRun[]> {
  return readJson<StoredRun[]>(kv, RUNS, []);
}

export async function pushRun(kv: Kv, run: StoredRun): Promise<void> {
  const rows = await listRuns(kv);
  rows.unshift(run);
  await kv.set(RUNS, JSON.stringify(rows.slice(0, 40)));
}

export async function lastCheckNow(kv: Kv): Promise<number | null> {
  const raw = await kv.get(CHECK_NOW);
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export async function markCheckNow(kv: Kv, nowMs: number): Promise<void> {
  await kv.set(CHECK_NOW, String(nowMs));
}

export async function telegramChat(kv: Kv, ownerId: string): Promise<string | null> {
  return kv.get(`telegram:chat:${ownerId}`);
}

export async function bindTelegram(kv: Kv, code: string, chatId: string): Promise<{ ok: true; ownerId: string } | { ok: false }> {
  const ownerId = await kv.get(`telegram:code:${code}`);
  if (!ownerId) return { ok: false };
  await kv.set(`telegram:chat:${ownerId}`, chatId);
  await kv.delete(`telegram:code:${code}`);
  return { ok: true, ownerId };
}

export async function ensureDemoAccount(kv: Kv, now = new Date()): Promise<void> {
  const day = now.toISOString().slice(0, 10);
  const raw = process.env.DEMO_CREDITS;
  const credits = raw === undefined || raw === "" ? 5 : Number(raw);
  if (Number.isInteger(credits) && credits >= 0) {
    await creditSet(kv, DEMO_USER_ID, credits, `demo-refill:${day}`);
  }
  const searches = await listSearches(kv);
  const presets = demoPresets(now.toISOString());
  let changed = false;
  for (const preset of presets) {
    if (!searches.some((item) => item.id === preset.id)) {
      searches.push(preset);
      changed = true;
    }
  }
  if (changed) await saveSearches(kv, searches);
}
