import type { FullReport } from "@/domain/types";
import { getKv, storageMode } from "./kv";
import { loadReport, saveReport } from "./store";

export async function persistReport(report: FullReport): Promise<void> {
  await getKv().set(`report:${report.id}`, JSON.stringify(report));
  if (storageMode() === "file") saveReport(report);
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
