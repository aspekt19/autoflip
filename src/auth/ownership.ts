import type { Kv } from "@/io/kv";
import { listUserReports } from "@/io/persist-report";

/** True when the report id appears in the owner's saved history. */
export async function userOwnsReport(kv: Kv, userId: string, reportId: string): Promise<boolean> {
  if (!userId || !reportId) return false;
  const reports = await listUserReports(kv, userId);
  return reports.some((item) => item.id === reportId);
}

/**
 * Cross-account guard for mutating or spending against another ledger id.
 * Client-supplied user ids are never trusted — compare to the server session owner.
 */
export function assertSameOwner(sessionUserId: string, targetUserId: string): boolean {
  return Boolean(sessionUserId) && sessionUserId === targetUserId;
}
