import type { Kv } from "@/io/kv";

/**
 * Bump when Check verdict / stop-flag / confidence logic changes so prior
 * month deliveries are not served as current (REPORT_7f0d: pre-#146 cache
 * hid park-outside stop flags).
 * v3: refuse to replay degraded / pre-min-confidence-cap results as current.
 */
export const CHECK_DELIVERY_LOGIC_VERSION = 3;

/**
 * True when a cached Check payload is too thin/degraded to replay as current.
 * Missing stop-flag fields or a High confidence next to Needs inspection.
 */
export function isDegradedCheckDeliveryResult(result: Record<string, unknown> | null | undefined): boolean {
  if (!result || typeof result !== "object") return true;
  const confidence = result.confidence;
  const verdict = result.verdict;
  const agent = result.agentVerdict;
  const agentVerdict =
    agent && typeof agent === "object" && !Array.isArray(agent)
      ? (agent as Record<string, unknown>).verdict
      : null;
  const agentConfidence =
    agent && typeof agent === "object" && !Array.isArray(agent)
      ? (agent as Record<string, unknown>).confidence
      : null;
  const label = typeof verdict === "string" ? verdict : typeof agentVerdict === "string" ? agentVerdict : null;
  const conf =
    typeof confidence === "string"
      ? confidence.toLowerCase()
      : typeof agentConfidence === "string"
        ? agentConfidence.toLowerCase()
        : null;
  if (label === "needs_inspection" && conf === "high") return true;
  // Pre-stop-flag caches omitted these keys entirely.
  if (!("openParkIt" in result) && !("openParkOutside" in result) && !("redFlags" in result)) {
    return true;
  }
  return false;
}

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
