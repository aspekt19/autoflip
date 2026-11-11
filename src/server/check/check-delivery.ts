import type { Kv } from "@/io/kv";

/**
 * Bump when Check verdict / stop-flag / confidence logic changes so prior
 * month deliveries are not served as current (REPORT_7f0d: pre-#146 cache
 * hid park-outside stop flags).
 */
export const CHECK_DELIVERY_LOGIC_VERSION = 2;

export type CheckDeliveryRecord = {
  settledAt: string;
  result: Record<string, unknown>;
  usedFreeCheck: boolean;
  spentCredit: boolean;
  /** Logic version that produced this result (missing on legacy rows). */
  logicVersion?: number;
};

export function checkDeliveryKey(
  userId: string,
  month: string,
  vinKey: string,
  logicVersion: number = CHECK_DELIVERY_LOGIC_VERSION,
): string {
  return `check-delivery:v${logicVersion}:${userId}:${month}:${vinKey}`;
}

/** Pre-versioned key — only used to detect stale cached results for labeling. */
export function legacyCheckDeliveryKey(userId: string, month: string, vinKey: string): string {
  return `check-delivery:${userId}:${month}:${vinKey}`;
}

export async function readCheckDelivery(kv: Kv, key: string): Promise<CheckDeliveryRecord | null> {
  const raw = await kv.get(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CheckDeliveryRecord;
    if (!parsed || typeof parsed.settledAt !== "string" || !parsed.result) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function storeCheckDelivery(kv: Kv, key: string, record: CheckDeliveryRecord): Promise<void> {
  await kv.set(
    key,
    JSON.stringify({
      ...record,
      logicVersion: record.logicVersion ?? CHECK_DELIVERY_LOGIC_VERSION,
    }),
  );
}
