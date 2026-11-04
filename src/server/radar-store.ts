import type { Kv } from "@/io/kv";
import type { SavedSearch, WatchAlert } from "@/domain/radar-watch";
import { syncPresetSearches } from "@/domain/demo-presets";
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

type SeenEntry = { vin: string; priceUsd: number | null };

function parseSeen(raw: unknown[]): SeenEntry[] {
  const entries: SeenEntry[] = [];
  for (const item of raw) {
    if (typeof item === "string") entries.push({ vin: item, priceUsd: null });
    else if (item && typeof item === "object" && "vin" in item && typeof (item as { vin?: unknown }).vin === "string") {
      const price = (item as { priceUsd?: unknown }).priceUsd;
      entries.push({ vin: (item as { vin: string }).vin, priceUsd: typeof price === "number" ? price : null });
    }
  }
  return entries;
}

export async function seenBook(kv: Kv, criteriaHash: string): Promise<Map<string, number | null>> {
  const rows = parseSeen(await readJson<unknown[]>(kv, `radar:seen:${criteriaHash}`, []));
  return new Map(rows.map((item) => [item.vin, item.priceUsd]));
}

export async function seenVins(kv: Kv, criteriaHash: string): Promise<Set<string>> {
  return new Set((await seenBook(kv, criteriaHash)).keys());
}

export async function storeSeen(kv: Kv, criteriaHash: string, vins: string[]): Promise<void> {
  const prior = await seenBook(kv, criteriaHash);
  const entries = vins.slice(-2000).map((vin) => ({ vin, priceUsd: prior.get(vin) ?? null }));
  await kv.set(`radar:seen:${criteriaHash}`, JSON.stringify(entries));
}

export async function storeSeenPrices(kv: Kv, criteriaHash: string, rows: SeenEntry[]): Promise<void> {
  await kv.set(`radar:seen:${criteriaHash}`, JSON.stringify(rows.slice(-2000)));
}

const LISTING_CACHE_MS = 3 * 60 * 60 * 1000;

export async function readListingCache(kv: Kv, url: string, nowMs: number): Promise<unknown | null> {
  const raw = await kv.get(`radar:listing-cache:${url}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { at?: number; body?: unknown };
    if (typeof parsed.at !== "number" || nowMs - parsed.at > LISTING_CACHE_MS) return null;
    return parsed.body ?? null;
  } catch {
    return null;
  }
}

export async function writeListingCache(kv: Kv, url: string, body: unknown, nowMs: number): Promise<void> {
  await kv.set(`radar:listing-cache:${url}`, JSON.stringify({ at: nowMs, body }));
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
  /** "over budget: 12, outside radius: 5" — empty when nothing was rejected. */
  filterBreakdown: string;
  alertsSent: number;
  autodevCalls: number;
  skippedDue: number;
  notes: string[];
  steps: { id: string; status: string; detail?: string }[];
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
  await upsertRun(kv, run);
}

export async function upsertRun(kv: Kv, run: StoredRun): Promise<void> {
  const rows = await listRuns(kv);
  const index = rows.findIndex((item) => item.id === run.id);
  if (index >= 0) rows[index] = run;
  else rows.unshift(run);
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
  const synced = syncPresetSearches(await listSearches(kv), now.toISOString());
  if (synced.changed) await saveSearches(kv, synced.searches);
}
