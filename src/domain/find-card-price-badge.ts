import { priceBadge, type PriceBadge } from "./price-badge";
import type { Listing } from "./types";

/** Loose car row from a Find shortlist or offer pool. */
export type FindCardCar = {
  vin?: string | null;
  year: number;
  make: string;
  model: string;
  trim?: string | null;
  priceUsd?: number | null;
  miles?: number | null;
  accidentCount?: number | null;
};

function asListing(car: FindCardCar, fallbackKey: string): Listing {
  const vin = typeof car.vin === "string" && car.vin.trim() ? car.vin.trim().toUpperCase() : fallbackKey;
  return {
    vin,
    year: car.year,
    make: car.make,
    model: car.model,
    trim: car.trim ?? null,
    miles: car.miles ?? null,
    priceUsd: car.priceUsd ?? null,
    city: null,
    state: null,
    zip: null,
    dealer: null,
    vdp: null,
    primaryImage: null,
    carfaxUrl: null,
    used: true,
    cpo: null,
    accidentCount: car.accidentCount ?? null,
    oneOwner: null,
    ownerCount: null,
    usageType: null,
    fuel: null,
    engine: null,
    drivetrain: null,
    bodyStyle: null,
    latitude: null,
    longitude: null,
    removedAt: null,
    source: "autodev",
  };
}

/**
 * Find card price badge from code math on the offer/market pool.
 * Never labels Fair/Good/High price when fair value cannot be computed.
 */
export function findCardPriceBadge(subject: FindCardCar, pool: readonly FindCardCar[]): PriceBadge {
  const listings = pool.map((row, index) => asListing(row, `POOL-${index + 1}`));
  const sub = asListing(subject, "SUBJECT");
  const withSubject = listings.some((row) => row.vin === sub.vin) ? listings : [sub, ...listings];
  return priceBadge(sub, withSubject);
}
