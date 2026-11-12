import { createHash } from "node:crypto";
import type { ResaleSearchDelivery } from "@/server/resale-search-credit";
import { RESALE_SPEC_CACHE_MS } from "@/domain/resale-sanity";
import type { ResaleSearchInput } from "@/domain/resale-search-input";
import type { Kv } from "@/io/kv";

/** Stable hash of the resale spec. Live runs cache the decision under this for 24 hours. */
export function resaleSpecHash(input: ResaleSearchInput): string {
  const canonical = {
    budgetUsd: input.budgetUsd,
    zip: input.zip,
    distanceMiles: input.distanceMiles,
    bodyStyle: input.bodyStyle,
    preferredMakes: [...input.preferredMakes].map((item) => item.toLowerCase()).sort(),
    preferredModels: [...input.preferredModels]
      .map((item) => `${item.make.toLowerCase()}|${item.model.toLowerCase()}`)
      .sort(),
    yearMin: input.yearMin,
    yearMax: input.yearMax,
    milesMax: input.milesMax,
    repairAbility: input.repairAbility,
    targetProfitUsd: input.targetProfitUsd,
    timeToSell: input.timeToSell,
    resaleChannel: input.resaleChannel,
    asIs: input.asIs === true,
    sellWithinDays: input.sellWithinDays,
    freeText: input.freeText?.trim().toLowerCase() ?? null,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

type Cached = { exp: number; delivery: ResaleSearchDelivery };

function keyFor(hash: string): string {
  return `resale:spec:v1:${hash}`;
}

const VERDICT_ACTIONS = new Set(["buy", "negotiate", "pass", "needs_inspection"]);

/** A 24h replay is only a finished verdict. A stop or a non-verdict is searched again. */
export function resaleDeliveryReusable(delivery: ResaleSearchDelivery): boolean {
  const action = delivery.verdictAction;
  if (typeof action !== "string" || !VERDICT_ACTIONS.has(action)) return false;
  const message = `${typeof delivery.message === "string" ? delivery.message : ""} ${typeof delivery.headline === "string" ? delivery.headline : ""}`;
  if (/not enough information for a verdict|stopped before a verdict|did not meet the checks for a published verdict/i.test(message)) {
    return false;
  }
  if (action === "pass" && (delivery.best == null || typeof delivery.best !== "object")) return false;
  return true;
}

export async function readResaleSpecCache(
  kv: Kv,
  input: ResaleSearchInput,
  nowMs = Date.now(),
): Promise<ResaleSearchDelivery | null> {
  const raw = await kv.get(keyFor(resaleSpecHash(input)));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Cached;
    if (!parsed || typeof parsed.exp !== "number" || parsed.exp <= nowMs || !parsed.delivery) return null;
    if (!resaleDeliveryReusable(parsed.delivery)) return null;
    return parsed.delivery;
  } catch {
    return null;
  }
}

export async function writeResaleSpecCache(
  kv: Kv,
  input: ResaleSearchInput,
  delivery: ResaleSearchDelivery,
  nowMs = Date.now(),
): Promise<void> {
  const key = keyFor(resaleSpecHash(input));
  if (!resaleDeliveryReusable(delivery)) {
    await kv.delete(key);
    return;
  }
  const payload: Cached = { exp: nowMs + RESALE_SPEC_CACHE_MS, delivery };
  await kv.set(key, JSON.stringify(payload));
}
