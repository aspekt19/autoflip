import type { Kv } from "@/io/kv";
import { LINK_TTL_MS } from "@/io/telegram";
import type { SavedSearch, WatchAlert } from "@/domain/radar-watch";
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
  servChecks?: Array<{
    purpose: string;
    modelRequested: string;
    modelReported: string;
    tools: string[];
    features: string[];
    promptGuard: string;
    shadowOutcome: string;
    shadowMaxIterations: number | null;
    latencyMs: number;
  }>;
  /** Owners whose watches were due in this run (for per-account activity). */
  ownerIds?: string[];
  /** Search ids checked in this run. */
  searchIds?: string[];
  /** Per SERV call log (verdict_decide / verdict_challenge / radar_review) with response ids. */
  servActivity?: Array<{
    at: string;
    searchId: string;
    vin: string;
    profile: string;
    modelRequested: string;
    modelReported: string;
    responseId: string | null;
    latencyMs: number;
    ok: boolean;
    decision: string | null;
    note: string | null;
    alerted: boolean;
  }>;
  /** Same journal schema as Resale search (`lemonless.resale_journal.v1`). */
  decisionJournal?: import("@/domain/resale-decision-journal").ResaleDecisionJournal;
  /** Per-watch listing/alert counts for owner-scoped activity (honest Flip/Drive-it totals). */
  perSearch?: Array<{ searchId: string; listings: number; alertsSent: number }>;
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

export async function telegramOwner(kv: Kv, chatId: string): Promise<string | null> {
  return kv.get(`telegram:owner:${chatId}`);
}

export async function telegramPaused(kv: Kv, ownerId: string): Promise<boolean> {
  return (await kv.get(`telegram:paused:${ownerId}`)) === "1";
}

export async function setTelegramPaused(kv: Kv, ownerId: string, paused: boolean): Promise<void> {
  if (paused) await kv.set(`telegram:paused:${ownerId}`, "1");
  else await kv.delete(`telegram:paused:${ownerId}`);
}

export async function saveTelegramCode(kv: Kv, code: string, ownerId: string, now = Date.now()): Promise<void> {
  await kv.set(`telegram:code:${code}`, JSON.stringify({ ownerId, expiresAt: now + LINK_TTL_MS }));
}

export async function bindTelegram(
  kv: Kv,
  code: string,
  chatId: string,
  now = Date.now(),
): Promise<{ ok: true; ownerId: string } | { ok: false; reason: "expired" | "used" }> {
  const raw = await kv.get(`telegram:code:${code}`);
  if (!raw) return { ok: false, reason: "used" };
  let ownerId = raw;
  let expiresAt: number | null = null;
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as { ownerId?: string; expiresAt?: number };
      if (!parsed.ownerId) return { ok: false, reason: "used" };
      ownerId = parsed.ownerId;
      expiresAt = typeof parsed.expiresAt === "number" ? parsed.expiresAt : null;
    } catch {
      return { ok: false, reason: "used" };
    }
  }
  if (expiresAt !== null && now > expiresAt) {
    await kv.delete(`telegram:code:${code}`);
    return { ok: false, reason: "expired" };
  }
  await kv.set(`telegram:chat:${ownerId}`, chatId);
  await kv.set(`telegram:owner:${chatId}`, ownerId);
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
  // Do not seed demo/preset watches — Radar saved searches are account-owned only.
}
