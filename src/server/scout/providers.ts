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
    if (remaining.left <= 0) {
      return {
        ok: false,
        error: "provider_unavailable",
        message: "Scout provider hard ceiling exhausted before inventory.search.",
        providerCallsUsed: 0,
      };
    }

    // Atomic worst-case: reserve one call before fetch.
    const quota = await reserveAutodevCall(input.kv);
    if (!quota.ok) {
      return {
        ok: false,
        error: "provider_unavailable",
        message: quota.message,
        providerCallsUsed: 0,
      };
    }
    remaining.left -= 1;

    const make = mandate.preferredMakes[0];
    const result = await autodevSearch(
      {
        make: make ?? undefined,
        zip: mandate.zip ?? undefined,
        distanceMiles: mandate.maxDistanceMiles ?? undefined,
        used: true,
        limit: 20,
        sort: "price",
      },
      {
        ...input.autodev,
        // Live rows must be tagged autodev; never sample/fixture.
        source: "autodev",
        reserve: async () => ({ ok: true, used: quota.used, limit: quota.limit }),
      },
    );

    if (!result.ok) {
      return {
        ok: false,
        error: result.error === "demo_limit" ? "provider_unavailable" : "provider_unavailable",
        message: result.message,
        providerCallsUsed: 1,
      };
    }

    const filtered = filterPool(result.listings, mandate);
    if (!filtered.length) {
      return {
        ok: false,
        error: "inventory_empty",
        message: "Live Auto.dev inventory produced zero listings after mandate filter.",
        providerCallsUsed: 1,
      };
    }

    return {
      ok: true,
      listings: filtered,
      source: "live",
      provenance: `live:api.auto.dev/listings (cached=${result.cached}; quota used ${result.quota.used}/${result.quota.limit})`,
      providerCallsUsed: result.cached ? 0 : 1,
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
