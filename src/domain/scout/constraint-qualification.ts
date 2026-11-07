/**
 * Per-field hard-constraint qualification — unknown ≠ verified match.
 * Known over-cap rows stay excluded by filterPool; retained unknowns must be labeled.
 * Never invent ZIP distance from unequal ZIP strings.
 */
import type { Listing } from "@/domain/types";
import {
  askingPriceUsabilityNote,
  isListingAskingPriceUsable,
  listingAskingPriceOpts,
} from "./asking-price";
import { listingGeoRelativeToSearch } from "./inventory";
import { mandatePriceCap, type ScoutSearchParams } from "./search-params";
import type {
  CandidateConstraintQualification,
  ConstraintFieldQualification,
  ConstraintFieldStatus,
  ScoutMandate,
} from "./types";

export type {
  CandidateConstraintQualification,
  ConstraintFieldQualification,
  ConstraintFieldStatus,
} from "./types";

function field(
  status: ConstraintFieldStatus,
  cap: number | null,
  observed: number | null,
  note: string,
): ConstraintFieldQualification {
  return { status, cap, observed, note };
}

export function qualifyListingConstraints(input: {
  listing: Listing;
  mandate: ScoutMandate;
  search?: ScoutSearchParams | null;
  searchFingerprint?: string | null;
}): CandidateConstraintQualification {
  const search = input.search ?? null;
  const priceCap = search?.maxPriceUsd != null ? search.maxPriceUsd : mandatePriceCap(input.mandate);
  const milesCap = search?.maxMiles != null ? search.maxMiles : input.mandate.maxMiles;
  const zip = search ? search.zip : input.mandate.zip;
  const radius = search ? search.distanceMiles : input.mandate.maxDistanceMiles;
  const models = search?.models ?? [];

  let price: ConstraintFieldQualification;
  if (priceCap == null) {
    price = field("not_applicable", null, input.listing.priceUsd, "No asking-price hard cap on this search.");
  } else if (input.listing.priceUsd == null) {
    price = field("unknown", priceCap, null, "Asking price unknown — not a verified under-cap match.");
  } else if (!isListingAskingPriceUsable(input.listing)) {
    price = field(
      "unknown",
      priceCap,
      input.listing.priceUsd,
      askingPriceUsabilityNote(input.listing.priceUsd, listingAskingPriceOpts(input.listing)) ??
        "Asking price not usable as genuine purchase-price evidence — not a verified under-cap match.",
    );
  } else if (input.listing.priceUsd > priceCap) {
    price = field("fail", priceCap, input.listing.priceUsd, "Asking price exceeds hard cap.");
  } else {
    price = field(
      "pass",
      priceCap,
      input.listing.priceUsd,
      "Asking price within hard cap and meets year-aware credible purchase magnitude (still seller claim).",
    );
  }

  let miles: ConstraintFieldQualification;
  if (milesCap == null) {
    miles = field("not_applicable", null, input.listing.miles, "No mileage hard cap on this search.");
  } else if (input.listing.miles == null) {
    miles = field("unknown", milesCap, null, "Mileage unknown — not a verified under-cap match.");
  } else if (input.listing.miles > milesCap) {
    miles = field("fail", milesCap, input.listing.miles, "Mileage exceeds hard cap.");
  } else {
    miles = field("pass", milesCap, input.listing.miles, "Mileage within hard cap.");
  }

  let geo: CandidateConstraintQualification["geo"];
  if (!zip || radius == null) {
    geo = {
      status: "not_applicable",
      cap: radius,
      observed: null,
      observedDistanceMiles: typeof input.listing.distanceMiles === "number" ? input.listing.distanceMiles : null,
      searchZip: zip,
      note: "Nationwide / no radius constraint — local match not claimed.",
    };
  } else {
    const g = listingGeoRelativeToSearch(input.listing, zip, radius);
    const observed =
      typeof input.listing.distanceMiles === "number" ? input.listing.distanceMiles : null;
    if (g === "out_of_range") {
      geo = {
        status: "fail",
        cap: radius,
        observed,
        observedDistanceMiles: observed,
        searchZip: zip,
        note: "Known distance exceeds radius.",
      };
    } else if (g === "unknown_geo") {
      geo = {
        status: "unknown",
        cap: radius,
        observed: null,
        observedDistanceMiles: null,
        searchZip: zip,
        note: "Distance unknown — ZIP string inequality is not used; not a verified local match.",
      };
    } else {
      geo = {
        status: "pass",
        cap: radius,
        observed,
        observedDistanceMiles: observed,
        searchZip: zip,
        note: "Known distance within radius.",
      };
    }
  }

  let model: CandidateConstraintQualification["model"];
  if (!models.length) {
    model = {
      status: "not_applicable",
      required: [],
      observed: input.listing.model,
      note: "No model filter on this search.",
    };
  } else {
    const ok = models.some((m) => m.toLowerCase() === input.listing.model.toLowerCase());
    model = {
      status: ok ? "pass" : "fail",
      required: models,
      observed: input.listing.model,
      note: ok ? "Model matches search filter." : "Model outside search filter.",
    };
  }

  const applicable = [price, miles, geo, model].filter((f) => f.status !== "not_applicable");
  const hardConstraintVerified =
    applicable.length > 0 && applicable.every((f) => f.status === "pass");

  return {
    price,
    miles,
    geo,
    model,
    hardConstraintVerified,
    searchFingerprint: input.searchFingerprint ?? null,
  };
}
