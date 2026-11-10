/**
 * Extract whatever a listing URL itself carries when the page is bot-walled.
 * Never invents VIN/YMM — only values present in the URL path/query.
 * Does not bypass anti-bot walls.
 */

import { extractVin } from "@/domain/vin";
import { yearMakeModelFromSlug, type YearMakeModelHit } from "./year-make-model";

export type ListingUrlHints = {
  url: string;
  host: string | null;
  site:
    | "cars.com"
    | "autotrader.com"
    | "cargurus.com"
    | "carmax.com"
    | "carvana.com"
    | "other";
  /** Site listing id when the path exposes one (UUID / numeric). */
  listingId: string | null;
  vin: string | null;
  ymm: YearMakeModelHit | null;
};

function hostOf(raw: string): string | null {
  try {
    return new URL(raw).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

function siteOf(host: string | null): ListingUrlHints["site"] {
  if (!host) return "other";
  if (host === "cars.com" || host.endsWith(".cars.com")) return "cars.com";
  if (host === "autotrader.com" || host.endsWith(".autotrader.com")) return "autotrader.com";
  if (host === "cargurus.com" || host.endsWith(".cargurus.com")) return "cargurus.com";
  if (host === "carmax.com" || host.endsWith(".carmax.com")) return "carmax.com";
  if (host === "carvana.com" || host.endsWith(".carvana.com")) return "carvana.com";
  return "other";
}

function listingIdFromPath(site: ListingUrlHints["site"], pathname: string): string | null {
  if (site === "cars.com") {
    const match = pathname.match(/\/vehicledetail\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?/i);
    return match?.[1] ?? null;
  }
  if (site === "autotrader.com") {
    const vehicle = pathname.match(/\/cars-for-sale\/vehicle\/(\d{5,})\/?/i);
    if (vehicle) return vehicle[1]!;
    const dealer = pathname.match(/\/car-dealers\/[^/]+\/(\d{4,})\//i);
    if (dealer) return dealer[1]!;
    return null;
  }
  if (site === "cargurus.com") {
    const match = pathname.match(/\/details\/(\d{5,})\/?/i);
    return match?.[1] ?? null;
  }
  if (site === "carmax.com") {
    const match = pathname.match(/\/car\/(\d{5,})\/?/i);
    return match?.[1] ?? null;
  }
  if (site === "carvana.com") {
    const match = pathname.match(/\/vehicle\/(\d{5,})/i) ?? pathname.match(/\/(\d{6,})\/?$/);
    return match?.[1] ?? null;
  }
  return null;
}

/** Parse listing identity hints from a public dealer/marketplace URL. */
export function listingUrlHints(raw: string): ListingUrlHints {
  const trimmed = raw.trim();
  const host = hostOf(trimmed);
  const site = siteOf(host);
  let pathname = trimmed;
  try {
    pathname = new URL(trimmed).pathname;
  } catch {
    /* keep raw */
  }
  return {
    url: trimmed,
    host,
    site,
    listingId: listingIdFromPath(site, pathname),
    vin: extractVin(trimmed),
    ymm: yearMakeModelFromSlug(trimmed),
  };
}

/** Buyer-facing one-liner about what the URL itself revealed (no invented facts). */
export function listingUrlHintsSummary(hints: ListingUrlHints): string {
  const bits: string[] = [];
  if (hints.site !== "other") bits.push(hints.site);
  if (hints.listingId) bits.push(`listing id ${hints.listingId}`);
  if (hints.vin) bits.push(`VIN ${hints.vin}`);
  if (hints.ymm) {
    bits.push(
      `${hints.ymm.year} ${hints.ymm.make} ${hints.ymm.model}${hints.ymm.trim ? ` ${hints.ymm.trim}` : ""}`.trim(),
    );
  }
  if (bits.length === 0) return "The URL did not expose a VIN, year/make/model, or listing id.";
  return `From the URL: ${bits.join(" · ")}.`;
}
