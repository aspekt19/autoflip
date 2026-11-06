import { parseAutoDevListings } from "@/io/parsers";
import type { Listing } from "@/domain/types";
import type { InventoryAdapterResult, ScoutMandate } from "./types";

export type InventoryAdapter = (mandate: ScoutMandate) => Promise<InventoryAdapterResult>;

/** Provenance for the only checked-in real Auto.dev listings JSON. */
export const REPLAY_CAMRY_PROVENANCE =
  "fixtures/autodev-camry.json (Auto.dev vehicle listings payload; row createdAt e.g. 2026-09-16; offline replay — not a live call)";

export function filterPool(listings: Listing[], mandate: ScoutMandate): Listing[] {
  return listings.filter((listing) => {
    if (mandate.preferredMakes.length && !mandate.openToOtherMakes) {
      const ok = mandate.preferredMakes.some(
        (make) => make.toLowerCase() === listing.make.toLowerCase(),
      );
      if (!ok) return false;
    }
    if (mandate.mode === "personal" && mandate.budgetKnown && mandate.budgetUsd != null) {
      if (listing.priceUsd != null && listing.priceUsd > mandate.budgetUsd * 1.25) return false;
    }
    return true;
  });
}

/**
 * Replay adapter — uses only an in-memory Auto.dev-shaped JSON object.
 * Never invents rows. Empty after filter → inventory_empty.
 */
export function replayInventoryAdapter(raw: unknown, provenance: string): InventoryAdapter {
  return async (mandate) => {
    let listings: Listing[];
    try {
      // Mark as sample at listing-row level so production never confuses fixture rows with live Auto.dev.
      listings = parseAutoDevListings(raw, "sample");
    } catch {
      return {
        ok: false,
        error: "provider_unavailable",
        message: "Replay payload could not be parsed as Auto.dev listings.",
        providerCallsUsed: 0,
      };
    }
    const filtered = filterPool(listings, mandate);
    if (!filtered.length) {
      return {
        ok: false,
        error: "inventory_empty",
        message: "Replay inventory produced zero listings after mandate filter.",
        providerCallsUsed: 0,
      };
    }
    return {
      ok: true,
      listings: filtered,
      source: "replay",
      provenance,
      providerCallsUsed: 0,
    };
  };
}

/** Live path stub — refuses when provider calls are disabled / key missing. */
export function unconfiguredInventoryAdapter(): InventoryAdapter {
  return async () => ({
    ok: false,
    error: "inventory_unconfigured",
    message: "Live inventory is not configured for this scout run (maxProviderCalls=0 or missing key).",
    providerCallsUsed: 0,
  });
}

export function unavailableInventoryAdapter(message: string): InventoryAdapter {
  return async () => ({
    ok: false,
    error: "provider_unavailable",
    message,
    providerCallsUsed: 0,
  });
}
