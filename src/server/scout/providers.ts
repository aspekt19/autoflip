/**
 * Inventory providers for Scout — same InventoryAdapter contract for replay and live.
 * Production must never label fixture/replay rows as live Auto.dev results.
 * Live path: zero server provider budget ⇒ zero network before any adapter dispatch.
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
  refundAutodevReservation,
  reserveAutodevCall,
  type PaidSpendAuthority,
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

export type ResolveLiveInventoryInput = {
  kv: Kv;
  autodev: AutodevDeps;
  env?: Record<string, string | undefined>;
  /** Server-owned remaining provider budget for this run (from serverScoutBudgets). */
  maxProviderCalls: number;
  /** Optional AbortSignal — ambiguous abort after dispatch must not refund. */
  signal?: AbortSignal | null;
  /** Test-only / future authority — never from env. */
  testAuthority?: PaidSpendAuthority | null;
};

/**
 * Live Auto.dev adapter. Refuses without verified non-env authority + Upstash Kv + budget > 0.
 * Each make reserves exactly one slot before that make's fetch; cache-hit refunds via DECR.
 */
export function resolveLiveInventory(input: ResolveLiveInventoryInput): ScoutInventoryResolution {
  const gate = authorizeLiveInventory({
    config: readPaidExecutionConfig(input.env),
    kv: input.kv,
    testAuthority: input.testAuthority ?? null,
  });
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

  if (input.maxProviderCalls <= 0) {
    return {
      mode: "replay",
      adapter: async () => ({
        ok: false,
        error: "provider_unavailable",
        message: "maxProviderCalls=0 — refusing live inventory before any provider HTTP.",
        providerCallsUsed: 0,
      }),
      isFixture: false,
      provenance: "live_blocked_zero_budget",
      paidBlockedReason: "Server provider budget is 0 — no live Auto.dev dispatch.",
    };
  }

  const remaining = {
    left: Math.min(gate.remainingProviderBudget, input.maxProviderCalls),
  };

  const adapter: InventoryAdapter = async (mandate: ScoutMandate) => {
    if (remaining.left <= 0) {
      return {
        ok: false,
        error: "provider_unavailable",
        message: "Scout provider budget exhausted before inventory.search — no HTTP dispatched.",
        providerCallsUsed: 0,
      };
    }

    if (input.signal?.aborted) {
      return {
        ok: false,
        error: "provider_unavailable",
        message: "Scout inventory aborted before dispatch — no reservation refund needed.",
        providerCallsUsed: 0,
      };
    }

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
      if (input.signal?.aborted) {
        // Ambiguous if a prior make already dispatched — do not refund prior reservations.
        break;
      }

      // Exact per-dispatch reserve BEFORE this make's network.
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

      let result: Awaited<ReturnType<typeof autodevSearch>>;
      try {
        result = await autodevSearch(
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
            // Mid-flight Request.signal + Autodev ownership timeout (combined inside fetch).
            signal: input.signal,
          },
        );
      } catch {
        // Ambiguous billed/timeout — reservation stands; no DECR.
        if (byVin.size === 0) {
          return {
            ok: false,
            error: "provider_unavailable",
            message: "Listing lookup failed after reservation — not refunded (conservative).",
            providerCallsUsed: providerCallsUsed + 1,
          };
        }
        break;
      }

      if (!result.ok) {
        // Upstream error after reserve — conservative: do not refund (may have been billed).
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

      const wasCached = result.cached;
      cachedFlags.push(wasCached);
      if (wasCached) {
        // Confirmed no network — refund monthly counter AND local remaining.
        await refundAutodevReservation(input.kv);
        remaining.left += 1;
      } else {
        providerCallsUsed += 1;
      }
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

export type ResolveScoutInventoryInput = {
  kv: Kv | null;
  autodev: AutodevDeps | null;
  preferLive: boolean;
  env?: Record<string, string | undefined>;
  maxProviderCalls: number;
  signal?: AbortSignal | null;
  testAuthority?: PaidSpendAuthority | null;
};

/**
 * Default resolution for HTTP/SDK: prefer live only when server-authorized;
 * otherwise replay with explicit fixture labeling. Never silently upgrades replay → live claim.
 */
export function resolveScoutInventory(input: ResolveScoutInventoryInput): ScoutInventoryResolution {
  if (input.preferLive) {
    if (input.kv && input.autodev) {
      const live = resolveLiveInventory({
        kv: input.kv,
        autodev: input.autodev,
        env: input.env,
        maxProviderCalls: input.maxProviderCalls,
        signal: input.signal,
        testAuthority: input.testAuthority,
      });
      if (live.mode === "live") return live;
      const replay = resolveReplayInventory();
      return { ...replay, paidBlockedReason: live.paidBlockedReason };
    }
    const gate = authorizeLiveInventory({
      config: readPaidExecutionConfig(input.env),
      kv: input.kv,
      testAuthority: input.testAuthority,
    });
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
