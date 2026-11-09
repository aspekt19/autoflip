/**
 * Red flags from listing description / extracted claims for /check.
 */
import type { CheckRedFlag, ExtractedListingFields } from "./types";
import { resolveMarketComps } from "@/domain/market-comps";
import type { Listing } from "@/domain/types";
import { isSoldAvailability } from "./schema-org";

const TITLE_BRAND_RE = /\b(salvage|rebuilt|reconstructed|flood|lemon|junk|branded title|reconditioned title|theft recovery)\b/i;
const AS_IS_RE = /\bas[\s-]?is\b/i;
const ACCIDENT_RE = /\b(accident|collision|damage history|frame damage|airbag(?:s)? deployed)\b/i;
const ODO_RE = /\b(odometer|mileage)\b.{0,40}\b(rollback|rolled back|inoperative|exempt|not actual|tampered)\b/i;
const MISSING_VIN_HINT = /\bVIN\s*(?:N\/?A|not available|unavailable|upon request)\b/i;
const SOLD_PHRASE_RE = /\b(?:this\s+)?(?:vehicle|car|truck)?\s*(?:has\s+been\s+)?SOLD\b|\bSOLD\s+(?:OUT|ONLINE|VEHICLE)\b|\bavailability[:\s]+sold\b/i;

export function listingRedFlags(input: {
  fields: ExtractedListingFields;
  description?: string | null;
  /** Extra page/paste text for phrase scans (as-is, salvage, …). */
  pageText?: string | null;
  subject?: Listing | null;
  compsPool?: Listing[];
}): CheckRedFlag[] {
  const flags: CheckRedFlag[] = [];
  const text = [
    input.pageText ?? "",
    input.description ?? "",
    input.fields.description.value ?? "",
    input.fields.titleStatus.value ?? "",
    input.fields.accidentsStated.value ?? "",
  ]
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  const sold =
    isSoldAvailability(input.fields.titleStatus.value) ||
    SOLD_PHRASE_RE.test(text) ||
    /\bSOLD\b/.test((input.fields.titleStatus.value ?? "").toUpperCase());
  if (sold) {
    flags.push({
      id: "sold",
      level: "stop",
      text: "This listing is marked SOLD. Do not treat it as an available car — confirm with the seller before planning a visit or wiring money.",
      source: "listing-availability",
    });
  }

  const titleHit =
    input.fields.titleStatus.value?.match(TITLE_BRAND_RE)?.[1] ??
    text.match(TITLE_BRAND_RE)?.[1] ??
    null;
  if (titleHit) {
    flags.push({
      id: "title_brand",
      level: "stop",
      text: `Listing text mentions “${titleHit}”. Treat this as a title-brand risk until an NMVTIS-approved report and the physical title prove otherwise.`,
      source: "listing-description",
    });
  }

  if (AS_IS_RE.test(text)) {
    flags.push({
      id: "as_is",
      level: "caution",
      text: "The listing says the car is sold “as is”. Ask what that covers and get an independent inspection before you pay.",
      source: "listing-description",
    });
  }

  if (ACCIDENT_RE.test(text) || /\b\d+\s+accident/i.test(input.fields.accidentsStated.value ?? "")) {
    const stated = input.fields.accidentsStated.value;
    flags.push({
      id: "accident",
      level: "caution",
      text: stated
        ? `The listing states: ${stated}. Ask for repair invoices and whether any airbags deployed.`
        : "The listing mentions accident or damage history. Ask for repair invoices and whether any airbags deployed.",
      source: "listing-description",
    });
  }

  if (ODO_RE.test(text)) {
    flags.push({
      id: "odometer",
      level: "stop",
      text: "The listing mentions an odometer problem (rollback, inoperative, or not actual mileage). Verify the title brands before trusting the mileage.",
      source: "listing-description",
    });
  }

  if (!input.fields.vin.value) {
    flags.push({
      id: "missing_vin",
      level: "caution",
      text: MISSING_VIN_HINT.test(text)
        ? "The listing does not publish a VIN. Ask the seller for the VIN plate photo before you rely on any history or recall check."
        : "No VIN was found on the listing page. Free government checks that need a VIN could not run.",
      source: "listing-extraction",
    });
  }

  const subject = input.subject;
  const pool = input.compsPool ?? [];
  if (subject && subject.priceUsd != null && pool.length > 0) {
    const market = resolveMarketComps(subject, pool);
    if (market.ok && market.fairValueUsd > 0) {
      const gap = (subject.priceUsd - market.fairValueUsd) / market.fairValueUsd;
      if (gap <= -0.18) {
        flags.push({
          id: "too_good_price",
          level: "caution",
          text: "The asking price looks far below similar listings. Confirm the VIN, title brand, and condition before treating the discount as real.",
          source: "price-comps",
        });
      }
    }
  }

  return flags;
}
