/**
 * /check orchestration: listing-link verdict or VIN dossier.
 * Uses shared adjusted-comparables pricing, free gov checks, OTD, seller questions.
 */
import { checkConfidence } from "@/domain/listing/confidence";
import { knownModelYearIssues } from "@/domain/listing/known-issues";
import { listingRedFlags } from "@/domain/listing/red-flags";
import { listingFromExtracted } from "@/domain/listing/to-listing";
import type {
  CheckConfidence,
  CheckRedFlag,
  CheckVerdictLabel,
  ExtractedListingFields,
} from "@/domain/listing/types";
import { priceBadge, type PriceBadge } from "@/domain/price-badge";
import {
  buildPurchaseReadiness,
  zipChoice,
  type PurchaseReadiness,
} from "@/domain/purchase-readiness";
import { dealerQuestions } from "@/domain/questions";
import { isValidVin } from "@/domain/vin";
import { verdictLabel } from "@/domain/format";
import type { FuelFact, Listing, RecallRecord, VinDecode } from "@/domain/types";
import { autodevByVin, autodevSearch, type AutodevDeps } from "@/io/autodev";
import {
  complaintCountFor,
  decodeVin,
  fuelFor,
  recallsFor,
  type GovDeps,
} from "@/io/gov";
import { safetyRatingsFor } from "@/io/nhtsa-safety";
import { extractFromListingUrl, extractFromPastedText, type ListingExtractDeps } from "./extract-listing";
import { getKv, type Kv } from "@/io/kv";
import { isServerlessRuntime, requireSharedQuotaForPaidDispatch } from "@/server/paid-dispatch-guard";
import { GENERATION_YEAR_WINDOW } from "@/domain/adjusted-comparables";
import { odometerCaution } from "@/domain/odometer";

export type CheckRunInput =
  | { kind: "link"; url: string; optionalZip?: string | null }
  | { kind: "paste"; text: string; url?: string | null; optionalZip?: string | null }
  | { kind: "vin"; vin: string; optionalZip?: string | null };

export type CheckRunDeps = ListingExtractDeps & {
  autodevKey?: string;
  autodev?: Pick<AutodevDeps, "cache" | "counter" | "reserve" | "signal" | "timeoutMs">;
  kv?: Kv;
  env?: Record<string, string | undefined>;
  now?: Date;
};

export type FieldProvenanceRow = {
  field: string;
  value: string | number | string[] | null;
  source: string | null;
};

export type CheckResultPayload = {
  kind: "listing" | "vin_dossier";
  title: string;
  verdict: CheckVerdictLabel;
  verdictLabel: string;
  confidence: CheckConfidence;
  summary: string;
  badge: PriceBadge | null;
  fairValueUsd: number | null;
  priceGap: number | null;
  compCount: number;
  compScope: string;
  redFlags: CheckRedFlag[];
  questions: string[];
  otd: PurchaseReadiness["otd"] | null;
  otdNeedsZip: boolean;
  fields: ExtractedListingFields | null;
  provenance: FieldProvenanceRow[];
  vin: string | null;
  vinDecode: VinDecode | null;
  recalls: RecallRecord[];
  recallsAvailable: boolean;
  complaintCount: number | null;
  fuel: FuelFact | null;
  safetySummary: string | null;
  knownIssues: Array<{ text: string; source: string }>;
  unknown: string[];
  listingsForVin: Array<{
    priceUsd: number | null;
    miles: number | null;
    dealer: string | null;
    vdp: string | null;
    city: string | null;
    state: string | null;
  }>;
  llmUsed: boolean;
  sample: boolean;
};

export type CheckRunResult =
  | { ok: true; result: CheckResultPayload }
  | {
      ok: false;
      status: number;
      error: string;
      message: string;
      blocked?: boolean;
      alternatives?: Array<"paste_text" | "enter_vin">;
    };

function provenanceRows(fields: ExtractedListingFields): FieldProvenanceRow[] {
  const keys = Object.keys(fields) as Array<keyof ExtractedListingFields>;
  return keys.map((field) => {
    const row = fields[field];
    return {
      field,
      value: row.value as string | number | string[] | null,
      source: row.source,
    };
  });
}

function unknownList(fields: ExtractedListingFields | null, extras: string[] = []): string[] {
  const missing: string[] = [...extras];
  if (!fields) return missing;
  const labels: Array<[keyof ExtractedListingFields, string]> = [
    ["vin", "VIN"],
    ["priceUsd", "asking price"],
    ["year", "year"],
    ["make", "make"],
    ["model", "model"],
    ["miles", "mileage"],
    ["zip", "ZIP / location"],
    ["titleStatus", "title status"],
    ["accidentsStated", "accident history on listing"],
    ["ownersStated", "owner count on listing"],
  ];
  for (const [key, label] of labels) {
    if (fields[key].value == null) missing.push(label);
  }
  return missing;
}

async function searchComps(input: {
  make: string;
  model: string;
  year: number;
  zip: string | null;
  deps: CheckRunDeps;
  fetchImpl: typeof fetch;
}): Promise<{ listings: Listing[]; scope: string; sample: boolean }> {
  if (!input.deps.autodevKey || !input.deps.autodev) {
    return { listings: [], scope: "Listings provider not configured", sample: false };
  }
  const kv = input.deps.kv ?? getKv();
  const gate = requireSharedQuotaForPaidDispatch({
    kv,
    serverless: isServerlessRuntime(input.deps.env ?? process.env),
  });
  if (!gate.ok) {
    return { listings: [], scope: "Listings quota backend unavailable", sample: false };
  }
  const zip = input.zip?.replace(/\D/g, "").slice(0, 5) || undefined;
  const yearMin = Math.max(1981, input.year - GENERATION_YEAR_WINDOW);
  const yearMax = input.year + GENERATION_YEAR_WINDOW;
  const search = await autodevSearch(
    {
      make: input.make,
      model: input.model,
      yearRange: `${yearMin}-${yearMax}`,
      zip,
      distanceMiles: zip ? 100 : undefined,
      limit: 24,
    },
    {
      fetch: input.fetchImpl,
      cache: input.deps.autodev.cache,
      counter: input.deps.autodev.counter,
      apiKey: input.deps.autodevKey,
      now: input.deps.now,
      reserve: input.deps.autodev.reserve,
      signal: input.deps.autodev.signal,
      timeoutMs: input.deps.autodev.timeoutMs,
    },
  );
  if (!search.ok) {
    return { listings: [], scope: search.message, sample: false };
  }
  return {
    listings: search.listings,
    scope: zip
      ? `Same ${input.make} ${input.model}, within ${GENERATION_YEAR_WINDOW} model years, near ZIP ${zip}`
      : `Same ${input.make} ${input.model}, within ${GENERATION_YEAR_WINDOW} model years`,
    sample: false,
  };
}

async function govBundle(
  vin: string | null,
  subject: Pick<Listing, "year" | "make" | "model" | "engine">,
  gov: GovDeps,
): Promise<{
  vinDecode: VinDecode | null;
  recalls: RecallRecord[];
  recallsAvailable: boolean;
  complaintCount: number | null;
  fuel: FuelFact | null;
  safetySummary: string | null;
}> {
  const [vinDecode, recallLookup, complaintCount, fuel, safety] = await Promise.all([
    vin && isValidVin(vin) ? decodeVin(vin, gov) : Promise.resolve(null),
    recallsFor(subject.make, subject.model, subject.year, gov),
    complaintCountFor(subject.make, subject.model, subject.year, gov),
    fuelFor(subject.year, subject.make, subject.model, subject.engine, gov),
    safetyRatingsFor(subject.make, subject.model, subject.year, gov),
  ]);
  let safetySummary: string | null = null;
  if (!safety.available) {
    safetySummary = "NHTSA crash ratings were unavailable for this year, make, and model.";
  } else if (safety.variants.length === 0) {
    safetySummary = "NHTSA returned no crash-rating variants for this year, make, and model.";
  } else {
    const overall = safety.variants
      .map((v) => v.overallRating)
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0);
    safetySummary = overall.length
      ? `NHTSA overall ratings for configurations of this model year: ${[...new Set(overall)].join(", ")}. Ratings are configuration-level, not VIN-specific.`
      : "NHTSA listed configurations but no overall star rating was published (Not Rated stays unknown).";
  }
  return {
    vinDecode,
    recalls: recallLookup.records,
    recallsAvailable: recallLookup.available,
    complaintCount,
    fuel,
    safetySummary,
  };
}

function mismatchNote(decode: VinDecode | null, listing: Listing): boolean {
  if (!decode || decode.errorCode && !/^0\b/.test(decode.errorCode) && decode.errorCode !== "0") {
    // Incomplete decode — do not claim mismatch.
    if (decode && decode.errorCode && decode.errorCode !== "0" && !decode.errorCode.startsWith("0,")) {
      return false;
    }
  }
  if (!decode?.year || !decode.make || !decode.model) return false;
  const yearOk = decode.year === listing.year;
  const makeOk = decode.make.toLowerCase() === listing.make.toLowerCase();
  const modelOk = decode.model.toLowerCase() === listing.model.toLowerCase();
  return !(yearOk && makeOk && modelOk);
}

function verdictFromBadge(
  badge: PriceBadge | null,
  flags: CheckRedFlag[],
): { verdict: CheckVerdictLabel; label: string } {
  if (flags.some((f) => f.level === "stop")) {
    return { verdict: "walk_away", label: verdictLabel("walk_away") };
  }
  if (!badge || badge.tone === "unknown") {
    return { verdict: "insufficient_data", label: "Not enough price data — still a screening verdict" };
  }
  if (badge.tone === "good") return { verdict: "good_deal", label: verdictLabel("good_deal") };
  if (badge.tone === "fair") return { verdict: "fair", label: verdictLabel("fair") };
  return { verdict: "overpriced", label: verdictLabel("overpriced") };
}

async function buildListingVerdict(
  fields: ExtractedListingFields,
  input: {
    url?: string | null;
    optionalZip?: string | null;
    llmUsed: boolean;
    pageText?: string | null;
    deps: CheckRunDeps;
  },
): Promise<CheckRunResult> {
  const fetchImpl = input.deps.fetch ?? fetch;
  const listing = listingFromExtracted(fields, { vdp: input.url ?? null });
  if (!listing) {
    return {
      ok: false,
      status: 422,
      error: "insufficient_listing_data",
      message:
        "Could not identify year, make, and model from that listing. Paste the listing text, or enter the VIN.",
    };
  }

  const zip =
    input.optionalZip?.replace(/\D/g, "").slice(0, 5) ||
    fields.zip.value ||
    listing.zip ||
    null;

  // Prefer provider subject when VIN is known (richer history fields).
  let subject = listing;
  let providerListings: Listing[] = [];
  if (fields.vin.value && input.deps.autodevKey && input.deps.autodev) {
    const byVin = await autodevByVin(fields.vin.value, {
      fetch: fetchImpl,
      cache: input.deps.autodev.cache,
      counter: input.deps.autodev.counter,
      apiKey: input.deps.autodevKey,
      now: input.deps.now,
      reserve: input.deps.autodev.reserve,
      signal: input.deps.autodev.signal,
      timeoutMs: input.deps.autodev.timeoutMs,
    });
    if (byVin.ok && byVin.listings[0]) {
      const feed = byVin.listings[0];
      subject = {
        ...feed,
        priceUsd: listing.priceUsd ?? feed.priceUsd,
        miles: listing.miles ?? feed.miles,
        zip: listing.zip ?? feed.zip,
        state: listing.state ?? feed.state,
        dealer: listing.dealer ?? feed.dealer,
        vdp: listing.vdp ?? feed.vdp,
        askingPriceKind: listing.askingPriceKind ?? feed.askingPriceKind,
        askingPriceProvenance: listing.askingPriceProvenance ?? feed.askingPriceProvenance,
        askingPriceSellerPageAccess: "obtained",
      };
      providerListings = byVin.listings;
    }
  }

  const comps = await searchComps({
    make: subject.make,
    model: subject.model,
    year: subject.year,
    zip,
    deps: input.deps,
    fetchImpl,
  });
  const pool =
    comps.listings.length > 0
      ? comps.listings.some((row) => row.vin === subject.vin)
        ? comps.listings
        : [subject, ...comps.listings]
      : [subject, ...providerListings];

  const badge = priceBadge(subject, pool);
  const gov = await govBundle(fields.vin.value, subject, { fetch: fetchImpl });
  const vinMismatch = mismatchNote(gov.vinDecode, subject);
  const flags = listingRedFlags({
    fields,
    description: fields.description.value,
    pageText: input.pageText ?? fields.description.value,
    subject,
    compsPool: pool,
  });
  const odo = odometerCaution({
    year: subject.year,
    miles: subject.miles,
    asOfYear: (input.deps.now ?? new Date()).getUTCFullYear(),
  });
  if (odo) {
    flags.push({ id: "odometer_age", level: "caution", text: odo, source: "odometer" });
  }
  if (vinMismatch) {
    flags.push({
      id: "vin_mismatch",
      level: "stop",
      text: "NHTSA’s VIN decode conflicts with the year, make, or model on the listing. Verify the VIN plate and title before proceeding.",
      source: "vin-identity",
    });
  }

  const parkIt = gov.recalls.some((r) => r.parkIt);
  const parkOutside = gov.recalls.some((r) => r.parkOutSide);
  const questions = dealerQuestions({
    listing: subject,
    recalls: gov.recalls,
    vinIdentityMismatch: vinMismatch,
    parkIt,
    parkOutside,
    historyMissing: subject.accidentCount === null || subject.ownerCount === null,
    titleBrandHit: fields.titleStatus.value?.match(
      /\b(salvage|rebuilt|flood|lemon|junk|branded title)\b/i,
    )?.[0] ?? null,
  });

  const zipPick = zipChoice(null, zip);
  const readiness =
    subject.priceUsd != null
      ? buildPurchaseReadiness({
          car: {
            vin: subject.vin,
            year: subject.year,
            make: subject.make,
            model: subject.model,
            trim: subject.trim,
            priceUsd: subject.priceUsd,
            miles: subject.miles,
            accidentCount: subject.accidentCount,
            askingPriceKind: subject.askingPriceKind ?? "purchase_ask",
            zip: zipPick.zip,
          },
          pool: pool.map((row) => ({
            vin: row.vin,
            year: row.year,
            make: row.make,
            model: row.model,
            trim: row.trim,
            priceUsd: row.priceUsd,
            miles: row.miles,
            accidentCount: row.accidentCount,
            askingPriceKind: row.askingPriceKind ?? "purchase_ask",
            zip: row.zip,
          })),
          zip: zipPick.zip,
          zipUsedFor: zipPick.zipUsedFor,
          now: input.deps.now ?? new Date(),
          recallCampaignCount: gov.recallsAvailable ? gov.recalls.length : null,
        })
      : null;

  const decided = verdictFromBadge(badge, flags);
  const confidence = checkConfidence({
    fields,
    hasVin: Boolean(fields.vin.value),
    govRan: Boolean(gov.vinDecode) || gov.recallsAvailable,
    compCount: badge.sampleSize ?? 0,
    listingSourceCount: provenanceRows(fields).filter((row) => row.value != null).length,
  });

  const knownIssues = knownModelYearIssues({
    year: subject.year,
    make: subject.make,
    model: subject.model,
    complaintCount: gov.complaintCount,
    recallCount: gov.recallsAvailable ? gov.recalls.length : null,
  });

  const summaryParts = [
    `${subject.year} ${subject.make} ${subject.model}${subject.trim ? ` ${subject.trim}` : ""}`,
    badge?.deltaLabel ?? "Price could not be rated from similar listings",
    flags.some((f) => f.level === "stop")
      ? "At least one stop-level red flag needs attention before you buy."
      : "Review the red flags and seller questions below.",
  ];

  return {
    ok: true,
    result: {
      kind: "listing",
      title: `${subject.year} ${subject.make} ${subject.model}`,
      verdict: decided.verdict,
      verdictLabel: decided.label,
      confidence,
      summary: summaryParts.join(". ") + ".",
      badge,
      fairValueUsd: badge.fairValueUsd,
      priceGap:
        badge.fairValueUsd != null && subject.priceUsd != null && badge.fairValueUsd > 0
          ? (subject.priceUsd - badge.fairValueUsd) / badge.fairValueUsd
          : null,
      compCount: badge.sampleSize ?? 0,
      compScope: comps.scope,
      redFlags: flags,
      questions,
      otd: readiness?.otd ?? null,
      otdNeedsZip: !zipPick.zip && subject.priceUsd != null,
      fields,
      provenance: provenanceRows(fields),
      vin: fields.vin.value,
      vinDecode: gov.vinDecode,
      recalls: gov.recalls,
      recallsAvailable: gov.recallsAvailable,
      complaintCount: gov.complaintCount,
      fuel: gov.fuel,
      safetySummary: gov.safetySummary,
      knownIssues,
      unknown: unknownList(fields, [
        "Paid vehicle history (Carfax/AutoCheck/NMVTIS) was not run",
      ]),
      listingsForVin: providerListings.map((row) => ({
        priceUsd: row.priceUsd,
        miles: row.miles,
        dealer: row.dealer,
        vdp: row.vdp,
        city: row.city,
        state: row.state,
      })),
      llmUsed: input.llmUsed,
      sample: comps.sample,
    },
  };
}

async function buildVinDossier(vin: string, deps: CheckRunDeps, optionalZip?: string | null): Promise<CheckRunResult> {
  if (!isValidVin(vin)) {
    return { ok: false, status: 400, error: "invalid_vin", message: "Enter a valid 17-character VIN." };
  }
  const fetchImpl = deps.fetch ?? fetch;
  const gov = { fetch: fetchImpl };
  const decode = await decodeVin(vin, gov);
  if (!decode?.year || !decode.make || !decode.model) {
    return {
      ok: false,
      status: 404,
      error: "vin_decode_failed",
      message: "The government VIN decoder did not return a usable year, make, and model for that VIN.",
    };
  }

  const stub: Listing = {
    vin,
    year: decode.year,
    make: decode.make,
    model: decode.model,
    trim: decode.trim ?? null,
    miles: null,
    priceUsd: null,
    city: null,
    state: null,
    zip: optionalZip?.replace(/\D/g, "").slice(0, 5) || null,
    dealer: null,
    vdp: null,
    primaryImage: null,
    carfaxUrl: null,
    used: true,
    cpo: null,
    accidentCount: null,
    oneOwner: null,
    ownerCount: null,
    usageType: null,
    fuel: decode.fuel ?? null,
    engine: decode.engine ?? null,
    drivetrain: decode.driveType ?? null,
    bodyStyle: decode.bodyClass ?? null,
    latitude: null,
    longitude: null,
    removedAt: null,
    source: "autodev",
  };

  let listingsForVin: Listing[] = [];
  if (deps.autodevKey && deps.autodev) {
    const byVin = await autodevByVin(vin, {
      fetch: fetchImpl,
      cache: deps.autodev.cache,
      counter: deps.autodev.counter,
      apiKey: deps.autodevKey,
      now: deps.now,
      reserve: deps.autodev.reserve,
      signal: deps.autodev.signal,
      timeoutMs: deps.autodev.timeoutMs,
    });
    if (byVin.ok) listingsForVin = byVin.listings;
  }

  const subject = listingsForVin[0]
    ? {
        ...listingsForVin[0],
        // Prefer decode identity when feed is thin
        year: listingsForVin[0].year || stub.year,
        make: listingsForVin[0].make || stub.make,
        model: listingsForVin[0].model || stub.model,
      }
    : stub;

  const bundle = await govBundle(vin, subject, gov);
  const knownIssues = knownModelYearIssues({
    year: subject.year,
    make: subject.make,
    model: subject.model,
    complaintCount: bundle.complaintCount,
    recallCount: bundle.recallsAvailable ? bundle.recalls.length : null,
  });

  const questions = dealerQuestions({
    listing: subject,
    recalls: bundle.recalls,
    parkIt: bundle.recalls.some((r) => r.parkIt),
    parkOutside: bundle.recalls.some((r) => r.parkOutSide),
    historyMissing: true,
  });

  const unknown = [
    "Asking price (not provided on a VIN-only check)",
    "Mileage (not provided on a VIN-only check)",
    "Paid vehicle history (Carfax/AutoCheck/NMVTIS) was not run",
    "Title brand status from a paid report",
  ];
  if (!listingsForVin.length) unknown.push("Current dealer listings for this VIN");

  const safetyKnown = bundle.safetySummary != null && !/unavailable/i.test(bundle.safetySummary);
  const recordCount = [bundle.recallsAvailable, bundle.complaintCount != null, safetyKnown].filter(Boolean).length;
  const confidence: CheckConfidence = recordCount >= 3 ? "High" : recordCount >= 1 ? "Medium" : "Low";
  const parkIt = bundle.recalls.some((row) => row.parkIt);

  const summary = [
    `VIN dossier for ${subject.year} ${subject.make} ${subject.model}.`,
    parkIt
      ? "A model-year park-it campaign is on file. Do not treat this VIN as cleared to drive until applicability and repair are confirmed."
      : bundle.recallsAvailable
        ? bundle.recalls.length === 0
          ? "No recall campaigns were listed for this model year. That is not a VIN-specific repair check."
          : `${bundle.recalls.length} model-year recall campaign${bundle.recalls.length === 1 ? "" : "s"} are on file. Repair status for this exact VIN is still unknown.`
        : "Recall campaigns could not be checked.",
    "There is no asking price on a VIN-only check, so this car is not price-rated.",
    listingsForVin.length
      ? `Found ${listingsForVin.length} current listing${listingsForVin.length === 1 ? "" : "s"} for this VIN.`
      : "No current dealer listing for this VIN was returned.",
    "This uses free government records only, not a paid history report.",
  ].join(" ");

  return {
    ok: true,
    result: {
      kind: "vin_dossier",
      title: `${subject.year} ${subject.make} ${subject.model}`,
      verdict: "dossier",
      verdictLabel: "VIN dossier (free sources)",
      confidence,
      summary,
      badge: null,
      fairValueUsd: null,
      priceGap: null,
      compCount: 0,
      compScope: "VIN dossier does not rate price without an asking price",
      redFlags: bundle.recalls.some((r) => r.parkIt)
        ? [
            {
              id: "park_it",
              level: "stop",
              text: "NHTSA lists a park-it (do not drive) campaign for this model year. Verify VIN applicability before driving.",
              source: "nhtsa-recalls",
            },
          ]
        : [],
      questions,
      otd: null,
      otdNeedsZip: false,
      fields: null,
      provenance: [
        { field: "vin", value: vin, source: "typed VIN" },
        { field: "year", value: subject.year, source: "government VIN decoder" },
        { field: "make", value: subject.make, source: "government VIN decoder" },
        { field: "model", value: subject.model, source: "government VIN decoder" },
      ],
      vin,
      vinDecode: bundle.vinDecode ?? decode,
      recalls: bundle.recalls,
      recallsAvailable: bundle.recallsAvailable,
      complaintCount: bundle.complaintCount,
      fuel: bundle.fuel,
      safetySummary: bundle.safetySummary,
      knownIssues,
      unknown,
      listingsForVin: listingsForVin.map((row) => ({
        priceUsd: row.priceUsd,
        miles: row.miles,
        dealer: row.dealer,
        vdp: row.vdp,
        city: row.city,
        state: row.state,
      })),
      llmUsed: false,
      sample: false,
    },
  };
}

export async function runCheck(input: CheckRunInput, deps: CheckRunDeps = {}): Promise<CheckRunResult> {
  if (input.kind === "vin") {
    return buildVinDossier(input.vin.trim().toUpperCase(), deps, input.optionalZip);
  }

  if (input.kind === "paste") {
    const extracted = await extractFromPastedText(input.text, deps, input.url);
    if (!extracted.ok) {
      if (extracted.blocked) {
        return {
          ok: false,
          status: 422,
          error: "listing_fetch_blocked",
          message: extracted.message,
          blocked: true,
          alternatives: extracted.alternatives,
        };
      }
      return {
        ok: false,
        status: 400,
        error: extracted.error,
        message: extracted.message,
      };
    }
    return buildListingVerdict(extracted.fields, {
      url: input.url,
      optionalZip: input.optionalZip,
      llmUsed: extracted.llmUsed,
      pageText: extracted.parse.llmText,
      deps,
    });
  }

  const extracted = await extractFromListingUrl(input.url, deps);
  if (!extracted.ok) {
    if (extracted.blocked) {
      return {
        ok: false,
        status: 422,
        error: "listing_fetch_blocked",
        message: extracted.message,
        blocked: true,
        alternatives: extracted.alternatives,
      };
    }
    return {
      ok: false,
      status: 400,
      error: extracted.error,
      message: extracted.message,
    };
  }
  return buildListingVerdict(extracted.fields, {
    url: extracted.fetch?.finalUrl ?? input.url,
    optionalZip: input.optionalZip,
    llmUsed: extracted.llmUsed,
    pageText: extracted.parse.llmText,
    deps,
  });
}
