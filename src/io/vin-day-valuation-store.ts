import {
  buildVinDayValuation,
  isVinDayValuation,
  preferExistingValuation,
  utcDateKey,
  vinDayValuationKey,
  type VinDayValuation,
} from "@/domain/vin-day-valuation";
import type { Kv } from "./kv";

export async function readVinDayValuation(
  kv: Kv,
  vin: string,
  now: Date = new Date(),
): Promise<VinDayValuation | null> {
  const key = vinDayValuationKey(vin, utcDateKey(now));
  const raw = await kv.get(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isVinDayValuation(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Record a priced evaluation for this VIN today.
 * If one already exists for the UTC day, keep the first (stable fair value).
 * Keys include the UTC date, so stale days are never reused.
 */
export async function rememberVinDayValuation(
  kv: Kv,
  input: {
    vin: string;
    fairValueUsd: number;
    sampleSize: number;
    methodNote: string;
    source: "find" | "check";
    now?: Date;
  },
): Promise<VinDayValuation | null> {
  const built = buildVinDayValuation(input);
  if (!built) return null;
  const existing = await readVinDayValuation(kv, built.vin, input.now ?? new Date());
  const keep = preferExistingValuation(existing, built);
  if (existing && keep === existing) return existing;
  await kv.set(vinDayValuationKey(keep.vin, keep.utcDate), JSON.stringify(keep));
  return keep;
}
