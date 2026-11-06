import { parseAutoDevListings } from "@/io/parsers";
import type { Listing } from "@/domain/types";
import { mandateWithSearch, type ScoutSearchParams } from "./search-params";
import type { InventoryAdapterResult, ScoutMandate } from "./types";

export type InventoryAdapterOpts = {
  /** Stage2C mid-loop bounded search adjustment (already mandate-validated by runner). */
  search?: ScoutSearchParams;
};

export type InventoryAdapter = (
  mandate: ScoutMandate,
  opts?: InventoryAdapterOpts,
) => Promise<InventoryAdapterResult>;

/** Provenance for the only checked-in real Auto.dev listings JSON. */
export const REPLAY_CAMRY_PROVENANCE =
  "fixtures/autodev-camry.json (Auto.dev vehicle listings payload; row createdAt e.g. 2026-09-16; offline replay — not a live call)";

export function filterPool(
  listings: Listing[],
  mandate: ScoutMandate,
  search?: ScoutSearchParams | null,
): Listing[] {
  const makes = search?.makes?.length ? search.makes : mandate.preferredMakes;
  const models = search?.models ?? [];
  const openToOther = search?.makes?.length ? false : mandate.openToOtherMakes;

  return listings.filter((listing) => {
    if (makes.length && !openToOther) {
      const ok = makes.some((make) => make.toLowerCase() === listing.make.toLowerCase());
      if (!ok) return false;
    }
    if (models.length) {
      const ok = models.some((model) => model.toLowerCase() === listing.model.toLowerCase());
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
 * Honors Stage2C search opts for make/model filter (geo preserved from mandate/search).
 */
export function replayInventoryAdapter(raw: unknown, provenance: string): InventoryAdapter {
  return async (mandate, opts) => {
    const effective = opts?.search ? mandateWithSearch(mandate, opts.search) : mandate;
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
    const filtered = filterPool(listings, effective, opts?.search ?? null);
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
      provenance: opts?.search
        ? `${provenance} | search=${JSON.stringify(opts.search)}`
        : provenance,
      providerCallsUsed: 0,
    };
  };
}

/**
 * Offline multi-fixture adapter for Stage2C proofs — selects fixture by first search/mandate make.
 * Never invents rows; spies can wrap this to prove actual dispatch + params.
 */
export function keyedReplayInventoryAdapter(
  byMake: Record<string, unknown>,
  provenancePrefix: string,
): InventoryAdapter {
  return async (mandate, opts) => {
    const makes = opts?.search?.makes?.length
      ? opts.search.makes
      : mandate.preferredMakes.length
        ? mandate.preferredMakes
        : Object.keys(byMake);
    const key = makes[0] ?? "";
    const raw =
      byMake[key] ??
      byMake[key.toLowerCase()] ??
      byMake[Object.keys(byMake).find((k) => k.toLowerCase() === key.toLowerCase()) ?? ""];
    if (!raw) {
      return {
        ok: false,
        error: "inventory_empty",
        message: `No offline fixture keyed for make ${key || "(none)"}.`,
        providerCallsUsed: 0,
      };
    }
    return replayInventoryAdapter(raw, `${provenancePrefix}:${key || "default"}`)(mandate, opts);
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
