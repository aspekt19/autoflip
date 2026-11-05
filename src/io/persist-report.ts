import type { FullReport, Mode, Verdict } from "@/domain/types";
import type { Kv } from "./kv";
import { getKv, storageMode } from "./kv";
import { loadReport, saveReport } from "./store";

export type UserReportSummary = {
  id: string;
  createdAt: string;
  vin: string;
  title: string;
  mode: Mode;
  verdict: Verdict;
  sample: boolean;
  priceUsd: number | null;
  miles: number | null;
  city: string | null;
  state: string | null;
};

const HISTORY_LIMIT = 50;
const FAVORITES_LIMIT = 50;

function historyKey(userId: string): string {
  return `reports:user:${userId}`;
}

function favoritesKey(userId: string): string {
  return `reports:favorites:${userId}`;
}

export async function persistReport(report: FullReport): Promise<void> {
  await getKv().set(`report:${report.id}`, JSON.stringify(report));
  if (storageMode() === "file") saveReport(report);
}

export async function rememberUserReport(
  kv: Kv,
  userId: string,
  vin: string,
  reportId: string,
  report?: FullReport,
): Promise<void> {
  await kv.set(`report-vin:${userId}:${vin.toUpperCase()}`, reportId);
  if (!report) return;

  const raw = await kv.get(historyKey(userId));
  let prior: UserReportSummary[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) prior = parsed as UserReportSummary[];
    } catch {
      prior = [];
    }
  }
  const car = report.computed.subject;
  const entry: UserReportSummary = {
    id: report.id,
    createdAt: report.createdAt,
    vin: car.vin,
    title: `${car.year} ${car.make} ${car.model}${car.trim ? ` ${car.trim}` : ""}`,
    mode: report.computed.mode,
    verdict: report.computed.verdict,
    sample: report.computed.sample,
    priceUsd: car.priceUsd,
    miles: car.miles,
    city: car.city,
    state: car.state,
  };
  const next = [entry, ...prior.filter((item) => item.id !== report.id)].slice(0, HISTORY_LIMIT);
  await kv.set(historyKey(userId), JSON.stringify(next));
}

export async function listUserReports(kv: Kv, userId: string): Promise<UserReportSummary[]> {
  const raw = await kv.get(historyKey(userId));
  if (!raw) return [];
  let entries: UserReportSummary[];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    entries = parsed.filter(
      (item): item is UserReportSummary =>
        Boolean(item) &&
        typeof item.id === "string" &&
        typeof item.createdAt === "string" &&
        typeof item.vin === "string" &&
        typeof item.title === "string",
    );
  } catch {
    return [];
  }

  const available: UserReportSummary[] = [];
  for (const item of entries) {
    if (await kv.get(`report:${item.id}`)) available.push(item);
  }
  return available.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function findUserReport(kv: Kv, userId: string, vin: string): Promise<string | null> {
  const id = await kv.get(`report-vin:${userId}:${vin.toUpperCase()}`);
  if (!id) return null;
  return (await kv.get(`report:${id}`)) ? id : null;
}

export async function readPersistedReport(id: string): Promise<FullReport | null> {
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(id)) return null;
  const raw = await getKv().get(`report:${id}`);
  if (raw) {
    try {
      return JSON.parse(raw) as FullReport;
    } catch {
      /* fall through */
    }
  }
  return loadReport(id);
}


export async function listFavoriteReportIds(kv: Kv, userId: string): Promise<string[]> {
  const raw = await kv.get(favoritesKey(userId));
  if (!raw) return [];
  let ids: unknown;
  try {
    ids = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(ids)) return [];
  const owned = new Set((await listUserReports(kv, userId)).map((item) => item.id));
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && owned.has(id)))]
    .slice(0, FAVORITES_LIMIT);
}

export async function setFavoriteReport(
  kv: Kv,
  userId: string,
  reportId: string,
  favorite: boolean,
): Promise<{ ok: true; favoriteIds: string[] } | { ok: false }> {
  if (!/^[a-zA-Z0-9-]{8,80}$/.test(reportId)) return { ok: false };
  const reports = await listUserReports(kv, userId);
  if (!reports.some((item) => item.id === reportId)) return { ok: false };

  const prior = await listFavoriteReportIds(kv, userId);
  const next = favorite
    ? [reportId, ...prior.filter((id) => id !== reportId)].slice(0, FAVORITES_LIMIT)
    : prior.filter((id) => id !== reportId);
  await kv.set(favoritesKey(userId), JSON.stringify(next));
  return { ok: true, favoriteIds: next };
}

export async function listFavoriteReports(kv: Kv, userId: string): Promise<UserReportSummary[]> {
  const ids = await listFavoriteReportIds(kv, userId);
  const byId = new Map((await listUserReports(kv, userId)).map((item) => [item.id, item]));
  return ids.map((id) => byId.get(id)).filter((item): item is UserReportSummary => Boolean(item));
}
