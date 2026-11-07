import { parseAutoDevListings } from "@/io/parsers";
import type { Listing } from "@/domain/types";
import { isUsableAskingPriceUsd } from "./asking-price";
import {
  mandatePriceCap,
  mandateWithSearch,
  type ScoutSearchParams,
} from "./search-params";
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

export type GeoFilterOutcome = "in_range" | "out_of_range" | "unknown_geo";

/**
 * Geo check: never fabricate distance from unequal ZIP strings.
 * Unknown geo (no listing.distanceMiles) is not treated as out-of-range.
 */
export function listingGeoRelativeToSearch(
  listing: Listing,
  zip: string | null,
  distanceMiles: number | null,
): GeoFilterOutcome {
  if (!zip || distanceMiles == null) return "in_range"; // nationwide / no radius constraint
  if (typeof listing.distanceMiles === "number" && Number.isFinite(listing.distanceMiles)) {
    return listing.distanceMiles <= distanceMiles ? "in_range" : "out_of_range";
  }
  // Do not invent distance from ZIP string inequality — unknown ≠ out-of-range.
  return "unknown_geo";
}

/**
 * Enforce buyer hard constraints at ingestion (asking price / miles / model / make / geo).
 * Asking prices only — never sold comps. Unknown geo does not masquerade as a local match claim.
 */
export function filterPool(
  listings: Listing[],
  mandate: ScoutMandate,
  search?: ScoutSearchParams | null,
): Listing[] {
  const makes = search?.makes?.length ? search.makes : mandate.preferredMakes;
  const models = search?.models ?? [];
  const openToOther = search?.makes?.length ? false : mandate.openToOtherMakes;
  const priceCap =
    search?.maxPriceUsd != null ? search.maxPriceUsd : mandatePriceCap(mandate);
  const milesCap = search?.maxMiles != null ? search.maxMiles : mandate.maxMiles;
  const zip = search ? search.zip : mandate.zip;
  const radius = search ? search.distanceMiles : mandate.maxDistanceMiles;

  return listings.filter((listing) => {
    if (makes.length && !openToOther) {
      const ok = makes.some((make) => make.toLowerCase() === listing.make.toLowerCase());
      if (!ok) return false;
    }
    if (models.length) {
      const ok = models.some((model) => model.toLowerCase() === listing.model.toLowerCase());
      if (!ok) return false;
    }
    if (priceCap != null && listing.priceUsd != null && listing.priceUsd > priceCap) {
      return false;
    }
    // Placeholder / suspicious feed asks are not genuine purchase-price evidence —
    // drop under priced search. Null ask stays (unknown ≠ invented); do not invent USD.
    // Suspicious ≠ vehicle defect; payment/downpayment interpretation is unproven.
    if (
      priceCap != null &&
      listing.priceUsd != null &&
      listing.priceUsd > 0 &&
      !isUsableAskingPriceUsd(listing.priceUsd, listing.year)
    ) {
      return false;
    }
    if (milesCap != null && listing.miles != null && listing.miles > milesCap) {
      return false;
    }
    const geo = listingGeoRelativeToSearch(listing, zip, radius);
    if (geo === "out_of_range") return false;
    // unknown_geo kept — caller must not claim local match without evidence.
    return true;
  });
}

function fixtureEvidenceFromListings(
  listings: Listing[],
  adapterDeclaredFixture: boolean,
): { isFixture: boolean; fixtureEvidence: "adapter_declared" | "listing_source_sample" | "both" | "unverifiable" } {
  const sampleRows = listings.length > 0 && listings.every((l) => l.source === "sample");
  if (adapterDeclaredFixture && sampleRows) {
    return { isFixture: true, fixtureEvidence: "both" };
  }
  if (adapterDeclaredFixture) {
    return { isFixture: true, fixtureEvidence: "adapter_declared" };
  }
  if (sampleRows) {
    return { isFixture: true, fixtureEvidence: "listing_source_sample" };
  }
  return { isFixture: false, fixtureEvidence: "unverifiable" };
}

/**
 * Replay adapter — uses only an in-memory Auto.dev-shaped JSON object.
 * Never invents rows. Empty after filter → inventory_empty.
 * Honors Stage2C search opts for make/model/price/miles/geo filter.
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
        isFixture: true,
      };
    }
    const filtered = filterPool(listings, effective, opts?.search ?? null);
    if (!filtered.length) {
      return {
        ok: false,
        error: "inventory_empty",
        message: "Replay inventory produced zero listings after mandate filter.",
        providerCallsUsed: 0,
        isFixture: true,
      };
    }
    const fx = fixtureEvidenceFromListings(filtered, true);
    return {
      ok: true,
      listings: filtered,
      source: "replay",
      provenance: opts?.search
        ? `${provenance} | search=${JSON.stringify(opts.search)}`
        : provenance,
      providerCallsUsed: 0,
      isFixture: fx.isFixture,
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
        isFixture: true,
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
    isFixture: false,
  });
}

export function unavailableInventoryAdapter(message: string): InventoryAdapter {
  return async () => ({
    ok: false,
    error: "provider_unavailable",
    message,
    providerCallsUsed: 0,
    isFixture: false,
  });
}

export { fixtureEvidenceFromListings };
