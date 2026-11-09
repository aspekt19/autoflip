/**
 * One-shot rebuild: strip plainLlmOffline, mark synthetic, recompute scoring
 * labels from production modules (never hand-pick fair values / winners).
 *
 * Run: npx tsx eval/comparison/rebuild-fixture-labels.ts
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { listingRedFlags } from "../../src/domain/listing/red-flags";
import type { ExtractedListingFields } from "../../src/domain/listing/types";
import { evaluateListingPrice } from "../../src/domain/price-evaluation";
import type { Listing } from "../../src/domain/types";
import type {
  CapturedListing,
  CheckCaseFixture,
  FindCaseFixture,
  LabelProvenance,
  PriceBand,
} from "./types";
import { bandFromAskVsFair } from "./score";

const FIND_PATH = resolve("eval/comparison/fixtures/find-cases.json");
const CHECK_PATH = resolve("eval/comparison/fixtures/check-cases.json");

function toListing(row: CapturedListing): Listing {
  return {
    vin: (row.vin ?? `NOVIN${row.year}${row.make}${row.model}`)
      .replace(/[^A-Z0-9]/gi, "")
      .slice(0, 17)
      .toUpperCase()
      .padEnd(17, "0"),
    year: row.year,
    make: row.make,
    model: row.model,
    trim: row.trim,
    priceUsd: row.priceUsd,
    miles: row.miles,
    city: row.city ?? null,
    state: row.state ?? null,
    zip: null,
    vdp: row.sourceUrl ?? null,
    dealer: null,
    source: "sample",
    primaryImage: null,
    carfaxUrl: null,
    used: true,
    cpo: null,
    accidentCount: null,
    ownerCount: null,
    oneOwner: null,
    usageType: null,
    createdAt: null,
    engine: null,
    drivetrain: null,
    fuel: null,
    bodyStyle: null,
    latitude: null,
    longitude: null,
    removedAt: null,
  };
}

function emptyFields(subject: CapturedListing): ExtractedListingFields {
  const cell = <T,>(value: T | null) => ({ value, source: "visible_text" as const });
  return {
    year: cell(subject.year),
    make: cell(subject.make),
    model: cell(subject.model),
    trim: cell(subject.trim),
    priceUsd: cell(subject.priceUsd),
    miles: cell(subject.miles),
    vin: cell(subject.vin),
    titleStatus: cell(subject.titleStatus ?? (subject.availability === "sold" ? "SOLD" : null)),
    accidentsStated: cell(null),
    description: cell(subject.description ?? null),
    drivetrain: cell(null),
    fuel: cell(null),
    transmission: cell(null),
    color: cell(null),
    location: cell(null),
    zip: cell(null),
    state: cell(subject.state ?? null),
    sellerName: cell(null),
    listingDate: cell(null),
    photoCount: cell(null),
    ownersStated: cell(null),
    features: cell(null),
  };
}

function soldIds(row: CapturedListing, text: string): string[] {
  if (row.availability === "sold" || /\bSOLD\b/i.test(text) || /schema\.org\/SoldOut/i.test(text)) {
    return ["sold"];
  }
  return [];
}

function missingVinIds(row: CapturedListing, text: string): string[] {
  if (!row.vin || /VIN\s*(N\/?A|not available|unavailable|upon request)/i.test(text)) {
    return ["missing_vin"];
  }
  return [];
}

function flagsFor(row: CapturedListing, pageText: string, comps: CapturedListing[]): string[] {
  const subject = toListing(row);
  const red = listingRedFlags({
    fields: emptyFields(row),
    description: row.description,
    pageText,
    subject,
    compsPool: comps.map(toListing),
  });
  return [
    ...soldIds(row, pageText),
    ...missingVinIds(row, pageText),
    ...(/\brecall\b/i.test(pageText) ? ["recall"] : []),
    ...red.map((f) => f.id),
  ];
}

const provenanceBase: LabelProvenance = {
  fairValueMethod: "evaluateListingPrice(subject, comps∪listings) — production price module",
  redFlagMethod: "listingRedFlags + sold/missing_vin/recall heuristics on captured text",
  soldMethod: "availability===sold OR /\\bSOLD\\b/ OR schema.org/SoldOut in description/rawText",
  notes: "Harness-authored inventory (synthetic VINs). Labels recomputed; not hand-picked winners.",
};

function rebuildFind(raw: FindCaseFixture & { plainLlmOffline?: unknown; preferredVin?: unknown }): FindCaseFixture {
  const { plainLlmOffline: _drop, labels: oldLabels, ...rest } = raw as FindCaseFixture & {
    plainLlmOffline?: unknown;
  };
  const pool = [...raw.listings, ...raw.comps].map(toListing);
  const fairValueByVin: Record<string, number> = {};
  const expectedRedFlagIdsByVin: Record<string, string[]> = {};
  const soldVins: string[] = [];
  const expectedAvoidVins: string[] = [];

  for (const row of raw.listings) {
    if (!row.vin) continue;
    const fair = evaluateListingPrice(toListing(row), pool).fairValueUsd;
    if (fair != null) fairValueByVin[row.vin] = fair;
    const flags = flagsFor(row, row.description ?? "", raw.comps);
    if (flags.length) expectedRedFlagIdsByVin[row.vin] = [...new Set(flags)];
    if (flags.includes("sold")) soldVins.push(row.vin);
    if (flags.some((f) => /sold|title_brand|salvage|rebuilt|missing_vin|accident|fleet/i.test(f))) {
      expectedAvoidVins.push(row.vin);
    }
  }

  // Keep avoid VINs that old labels marked if still present (text may encode accident bait).
  for (const vin of oldLabels.expectedAvoidVins ?? []) {
    if (raw.listings.some((r) => r.vin === vin) && !expectedAvoidVins.includes(vin)) {
      expectedAvoidVins.push(vin);
    }
  }
  for (const vin of oldLabels.soldVins ?? []) {
    if (!soldVins.includes(vin) && raw.listings.some((r) => r.vin === vin)) soldVins.push(vin);
  }

  return {
    ...rest,
    synthetic: true,
    capture: {
      source: "harness_authored",
      url: null,
      note: "Synthetic Find inventory for offline CI — not a live marketplace capture. Prefer replacing with real captures over time.",
    },
    labels: {
      soldVins: [...new Set(soldVins)],
      expectedAvoidVins: [...new Set(expectedAvoidVins)],
      expectedRedFlagIdsByVin,
      fairValueByVin,
      provenance: provenanceBase,
    },
  };
}

function rebuildCheck(raw: CheckCaseFixture & { plainLlmOffline?: unknown }): CheckCaseFixture {
  const { plainLlmOffline: _drop, labels: _old, ...rest } = raw;
  const subject = toListing(raw.subject);
  const pool = raw.comps.map(toListing);
  const fair = evaluateListingPrice(subject, pool.length ? pool : [subject]).fairValueUsd;
  const flags = flagsFor(raw.subject, raw.rawText, raw.comps);
  const isSold = flags.includes("sold") || raw.subject.availability === "sold";
  const expectedPriceBand: PriceBand = isSold
    ? "unknown"
    : bandFromAskVsFair(raw.subject.priceUsd, fair ?? null);

  return {
    ...rest,
    synthetic: true,
    capture: {
      source: "harness_authored",
      url: raw.subject.sourceUrl ?? null,
      note: "Synthetic Check paste for offline CI — text/comps authored for the harness. Prefer real listing captures over time.",
    },
    labels: {
      isSold,
      expectedRedFlagIds: [...new Set(flags)],
      fairValueUsd: fair,
      expectedPriceBand,
      provenance: provenanceBase,
    },
  };
}

function main() {
  const findRaw = JSON.parse(
    require("node:fs").readFileSync(FIND_PATH, "utf8"),
  ) as { cases: Array<FindCaseFixture & { plainLlmOffline?: unknown }> };
  const checkRaw = JSON.parse(
    require("node:fs").readFileSync(CHECK_PATH, "utf8"),
  ) as { cases: Array<CheckCaseFixture & { plainLlmOffline?: unknown }> };

  const findOut = {
    schema: "lemonless.comparison.find_cases.v2",
    note: "All cases currently synthetic. Labels derived by rebuild-fixture-labels.ts from production modules. Arms never read labels.",
    cases: findRaw.cases.map(rebuildFind),
  };
  const checkOut = {
    schema: "lemonless.comparison.check_cases.v2",
    note: "All cases currently synthetic. Labels derived by rebuild-fixture-labels.ts from production modules. Arms never read labels.",
    cases: checkRaw.cases.map(rebuildCheck),
  };

  writeFileSync(FIND_PATH, `${JSON.stringify(findOut, null, 2)}\n`);
  writeFileSync(CHECK_PATH, `${JSON.stringify(checkOut, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        find: findOut.cases.length,
        check: checkOut.cases.length,
        syntheticFind: findOut.cases.filter((c) => c.synthetic).length,
        syntheticCheck: checkOut.cases.filter((c) => c.synthetic).length,
        wrote: [FIND_PATH, CHECK_PATH],
      },
      null,
      2,
    ),
  );
}

main();
