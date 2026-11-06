/**
 * Inventory providers for Scout — same InventoryAdapter contract for replay and live.
 * Production must never label fixture/replay rows as live Auto.dev results.
 */
import fixture from "../../../fixtures/autodev-camry.json";
import {
  REPLAY_CAMRY_PROVENANCE,
  filterPool,
  replayInventoryAdapter,
  type InventoryAdapter,
  type ScoutMandate,
} from "@/domain/scout";
import type { Listing } from "@/domain/types";
import { autodevSearch, type AutodevDeps } from "@/io/autodev";
import type { Kv } from "@/io/kv";
import {
  authorizeLiveInventory,
  readPaidExecutionConfig,
  reserveAutodevCall,
} from "./paid-execution";

export type InventoryMode = "replay" | "live";

export type ScoutInventoryResolution = {
  mode: InventoryMode;
  adapter: InventoryAdapter;
  /** True when rows come from checked-in fixtures — must surface to clients. */
  isFixture: boolean;
  provenance: string;
  paidBlockedReason: string | null;
};

/** Checked-in real-source Auto.dev JSON only. */
export function resolveReplayInventory(): ScoutInventoryResolution {
  return {
    mode: "replay",
    adapter: replayInventoryAdapter(fixture, REPLAY_CAMRY_PROVENANCE),
    isFixture: true,
    provenance: REPLAY_CAMRY_PROVENANCE,
    paidBlockedReason: null,
  };
}

/**
 * Live Auto.dev adapter using existing autodevSearch.
 * Refuses unless SCOUT_PAID_EXECUTION + key + hard ceiling are server-configured.
 * This function does not perform a network call until the returned adapter is invoked;
 * callers in this PR keep paidExecution off so the adapter is never exercised for spend.
 */
export function resolveLiveInventory(input: {
  kv: Kv;
  autodev: AutodevDeps;
  env?: Record<string, string | undefined>;
}): ScoutInventoryResolution {
  const gate = authorizeLiveInventory(readPaidExecutionConfig(input.env));
  if (!gate.ok) {
    return {
      mode: "replay",
      adapter: async () => ({
        ok: false,
        error: "inventory_unconfigured",
        message: gate.message,
        providerCallsUsed: 0,
      }),
      isFixture: false,
      provenance: "live_blocked",
      paidBlockedReason: gate.message,
    };
  }

  const remaining = { left: gate.remainingProviderBudget };

  const adapter: InventoryAdapter = async (mandate: ScoutMandate) => {
    // Search each preferred make (not just [0]); openToOtherMakes with empty prefs → one unscoped pull.
    const makes: Array<string | undefined> =
      mandate.preferredMakes.length > 0
        ? [...new Set(mandate.preferredMakes)]
        : mandate.openToOtherMakes
          ? [undefined]
          : [];
    if (!makes.length) {
      return {
        ok: false,
        error: "inventory_empty",
        message: "No preferred makes and openToOtherMakes=false — refused unscoped live pull.",
        providerCallsUsed: 0,
      };
    }

    const byVin = new Map<string, Listing>();
    let providerCallsUsed = 0;
    let lastUsed = 0;
    let lastLimit = 0;
    const cachedFlags: boolean[] = [];

    for (const make of makes) {
      if (remaining.left <= 0) break;

      // Atomic worst-case: reserve one call before each make's fetch.
      const quota = await reserveAutodevCall(input.kv);
      if (!quota.ok) {
        if (byVin.size === 0) {
          return {
            ok: false,
            error: "provider_unavailable",
            message: quota.message,
            providerCallsUsed,
          };
        }
        break;
      }
      remaining.left -= 1;
      lastUsed = quota.used;
      lastLimit = quota.limit;

      const result = await autodevSearch(
        {
          make,
          zip: mandate.zip ?? undefined,
          distanceMiles: mandate.maxDistanceMiles ?? undefined,
          used: true,
          limit: 20,
          sort: "price",
        },
        {
          ...input.autodev,
          source: "autodev",
          // Outer reserve already counted; do not double-charge.
          reserve: async () => ({ ok: true, used: quota.used, limit: quota.limit }),
        },
      );

      if (!result.ok) {
        if (byVin.size === 0) {
          return {
            ok: false,
            error: "provider_unavailable",
            message: result.message,
            providerCallsUsed: providerCallsUsed + 1,
          };
        }
        break;
      }
      cachedFlags.push(result.cached);
      if (!result.cached) providerCallsUsed += 1;
      else remaining.left += 1; // cache hit — slot unused for network
      for (const listing of filterPool(result.listings, mandate)) {
        if (!byVin.has(listing.vin)) byVin.set(listing.vin, listing);
      }
    }

    const filtered = [...byVin.values()];
    if (!filtered.length) {
      return {
        ok: false,
        error: "inventory_empty",
        message: "Live Auto.dev inventory produced zero listings after mandate filter.",
        providerCallsUsed,
      };
    }

    return {
      ok: true,
      listings: filtered,
      source: "live",
      provenance: `live:api.auto.dev/listings makes=${makes.map((m) => m ?? "*").join(",")}; cached=${cachedFlags.join(",")}; quota used ${lastUsed}/${lastLimit}`,
      providerCallsUsed,
    };
  };

  return {
    mode: "live",
    adapter,
    isFixture: false,
    provenance: "live:api.auto.dev/listings",
    paidBlockedReason: null,
  };
}

/**
 * Default resolution for HTTP/SDK: prefer live only when server-authorized;
 * otherwise replay with explicit fixture labeling. Never silently upgrades replay → live claim.
 */
export function resolveScoutInventory(input: {
  kv: Kv | null;
  autodev: AutodevDeps | null;
  preferLive: boolean;
  env?: Record<string, string | undefined>;
}): ScoutInventoryResolution {
  if (input.preferLive) {
    if (input.kv && input.autodev) {
      const live = resolveLiveInventory({ kv: input.kv, autodev: input.autodev, env: input.env });
      if (live.mode === "live") return live;
      const replay = resolveReplayInventory();
      return { ...replay, paidBlockedReason: live.paidBlockedReason };
    }
    const gate = authorizeLiveInventory(readPaidExecutionConfig(input.env));
    const replay = resolveReplayInventory();
    return {
      ...replay,
      paidBlockedReason: gate.ok
        ? "Live inventory requested but server Autodev deps/KV were not wired for this channel."
        : gate.message,
    };
  }
  return resolveReplayInventory();
}
