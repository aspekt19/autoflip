import { ASSUMPTIONS } from "./assumptions";
import type { HistoryAdjustment, Listing, Mode } from "./types";

function isFleet(usage: string | null): boolean {
  if (!usage) return false;
  return /fleet|rental|commercial|taxi|livery/i.test(usage);
}

export function historyAdjustment(listing: Listing, mode: Mode): HistoryAdjustment {
  let multiplier = 1;
  const lines: string[] = [];
  const accidents = listing.accidentCount;

  if (accidents === null) {
    // Missing history is not a clean record. Apply a published unknown-history haircut.
    multiplier *= 1 - ASSUMPTIONS.unknownHistoryHaircut;
    lines.push(
      `Accident count was not in the listing feed. Fair value is reduced by ${Math.round(ASSUMPTIONS.unknownHistoryHaircut * 100)}% because missing history is not treated as a clean record.`,
    );
  } else if (accidents > 0) {
    const haircut = Math.min(ASSUMPTIONS.accidentHaircutCap, accidents * ASSUMPTIONS.accidentHaircutEach);
    multiplier *= 1 - haircut;
    lines.push(
      `${accidents} accident${accidents === 1 ? "" : "s"} reported on the listing. Fair value is reduced by ${Math.round(haircut * 100)}% (the published price rule, capped at ${Math.round(ASSUMPTIONS.accidentHaircutCap * 100)}%).`,
    );
  } else {
    lines.push("The listing reports no accidents.");
  }

  if (listing.usageType === null) {
    lines.push("Usage type was not in the listing feed.");
  } else if (isFleet(listing.usageType)) {
    multiplier *= 1 - ASSUMPTIONS.fleetHaircut;
    lines.push(
      `Usage is “${listing.usageType}”. Fair value is reduced by ${Math.round(ASSUMPTIONS.fleetHaircut * 100)}% (the published price rule for fleet, rental, or commercial use).`,
    );
  } else {
    lines.push(`Usage on the listing is “${listing.usageType}”. No usage penalty.`);
  }

  if (listing.ownerCount === null && listing.oneOwner === null) {
    lines.push("Owner count was not in the listing feed.");
  } else if ((listing.ownerCount ?? 0) >= ASSUMPTIONS.multiOwnerAt) {
    multiplier *= 1 - ASSUMPTIONS.multiOwnerHaircut;
    lines.push(
      `${listing.ownerCount} owners reported. Fair value is reduced by ${Math.round(ASSUMPTIONS.multiOwnerHaircut * 100)}% (the published price rule at ${ASSUMPTIONS.multiOwnerAt}+ owners).`,
    );
  } else if (listing.oneOwner === true || listing.ownerCount === 1) {
    multiplier *= 1 + ASSUMPTIONS.oneOwnerBonus;
    lines.push(
      `One owner reported. Fair value is raised by ${Math.round(ASSUMPTIONS.oneOwnerBonus * 1000) / 10}% (the published price rule).`,
    );
  } else if (listing.ownerCount !== null) {
    lines.push(`${listing.ownerCount} owners reported. No owner penalty under ${ASSUMPTIONS.multiOwnerAt}.`);
  }

  if (mode === "personal" && listing.cpo === true) {
    multiplier *= 1 + ASSUMPTIONS.cpoBonusPersonal;
    lines.push(
      `Certified pre-owned. For a car you would drive, fair value is raised by ${Math.round(ASSUMPTIONS.cpoBonusPersonal * 100)}% (the published price rule). The certification is not treated as extra resale value in flip mode.`,
    );
  } else if (listing.cpo === null) {
    lines.push("Certified pre-owned status was not in the listing feed.");
  }

  return { multiplier, lines };
}
