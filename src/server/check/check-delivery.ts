import type { Kv } from "@/io/kv";

export type CheckDeliveryRecord = {
  settledAt: string;
  result: Record<string, unknown>;
  usedFreeCheck: boolean;
  spentCredit: boolean;
};

export function checkDeliveryKey(userId: string, month: string, vinKey: string): string {
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
  // Month-scoped — TTL a bit over a calendar month so stale keys expire.
  await kv.set(key, JSON.stringify(record), { ttlMs: 40 * 24 * 60 * 60 * 1000 });
}
