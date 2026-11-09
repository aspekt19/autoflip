/**
 * Map extracted listing fields onto the shared Listing shape used by comps/report.
 */
import type { Listing } from "@/domain/types";
import type { ExtractedListingFields } from "./types";

export function listingFromExtracted(
  fields: ExtractedListingFields,
  input: {
    vdp?: string | null;
    source?: Listing["source"];
    fallbackVin?: string | null;
  } = {},
): Listing | null {
  const vin = fields.vin.value ?? input.fallbackVin ?? null;
  const year = fields.year.value;
  const make = fields.make.value;
  const model = fields.model.value;
  if (!year || !make || !model) return null;

  const accidentsRaw = fields.accidentsStated.value ?? "";
  let accidentCount: number | null = null;
  if (/no accidents?|accident[- ]free/i.test(accidentsRaw)) accidentCount = 0;
  else {
    const n = accidentsRaw.match(/(\d+)\s+accident/i)?.[1];
    if (n) accidentCount = Number(n);
  }

  const ownersRaw = fields.ownersStated.value ?? "";
  let ownerCount: number | null = null;
  let oneOwner: boolean | null = null;
  if (/one[\s-]?owner|1[\s-]?owner|single[\s-]?owner/i.test(ownersRaw)) {
    ownerCount = 1;
    oneOwner = true;
  } else {
    const n = ownersRaw.match(/(\d+)\s+owners?/i)?.[1];
    if (n) {
      ownerCount = Number(n);
      oneOwner = ownerCount === 1;
    }
  }

  return {
    vin: vin ?? "UNKNOWN",
    year,
    make,
    model,
    trim: fields.trim.value,
    miles: fields.miles.value,
    priceUsd: fields.priceUsd.value,
    city: null,
    state: fields.state.value,
    zip: fields.zip.value,
    dealer: fields.sellerName.value,
    vdp: input.vdp ?? null,
    primaryImage: null,
    carfaxUrl: null,
    used: true,
    cpo: null,
    accidentCount,
    oneOwner,
    ownerCount,
    usageType: null,
    fuel: fields.fuel.value,
    engine: null,
    drivetrain: fields.drivetrain.value,
    bodyStyle: null,
    latitude: null,
    longitude: null,
    removedAt: null,
    createdAt: fields.listingDate.value,
    source: input.source ?? "autodev",
    askingPriceKind: fields.priceUsd.value != null ? "purchase_ask" : null,
    askingPriceProvenance: fields.priceUsd.source === "json_ld" || fields.priceUsd.source === "open_graph"
      ? "seller_page_labeled"
      : fields.priceUsd.value != null
        ? "seller_page_labeled"
        : "missing",
    askingPriceSellerPageAccess: "obtained",
  };
}
