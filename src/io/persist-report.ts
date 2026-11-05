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

function historyKey(userId: string): string {
  return `reports:user:${userId}`;
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
