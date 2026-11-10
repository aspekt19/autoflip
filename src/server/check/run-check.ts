/**
 * /check orchestration: listing-link verdict or VIN dossier.
 * Uses shared adjusted-comparables pricing, free gov checks, OTD, seller questions.
 */
import { buildCheckAgentVerdict } from "@/domain/build-check-agent-verdict";
import type { AgentVerdict } from "@/domain/agent-verdict-schema";
import { emptyAgentVerdict } from "@/domain/agent-verdict-schema";
import { buildCheckComputedReport } from "@/server/check/check-computed-report";
import { isServEndpointUrl } from "@/server/serv";
import {
  runShopperVerdictServ,
  type ShopperServTrace,
} from "@/server/shopper-verdict-serv";
import { checkConfidence } from "@/domain/listing/confidence";
import { knownModelYearIssues } from "@/domain/listing/known-issues";
import { listingRedFlags } from "@/domain/listing/red-flags";
import { fuelConflictNote } from "@/domain/listing/schema-org";
import { listingFromExtracted } from "@/domain/listing/to-listing";
import type {
  CheckConfidence,
  CheckRedFlag,
  CheckVerdictLabel,
  ExtractedListingFields,
} from "@/domain/listing/types";
import { extractedFieldsFromFeedListing } from "@/domain/listing/from-feed";
import {
  listingUrlHints,
  listingUrlHintsSummary,
  type ListingUrlHints,
} from "@/domain/listing/url-hints";
import { joinSummarySentences } from "@/domain/listing/year-make-model";
import { priceBadge, type PriceBadge } from "@/domain/price-badge";
import {
  buildPurchaseReadiness,
  zipChoice,
  type PurchaseReadiness,
  type SimilarCarView,
} from "@/domain/purchase-readiness";
import { dealerQuestions } from "@/domain/questions";
import { extractVin, isValidVin } from "@/domain/vin";
import { verdictLabel } from "@/domain/format";
import type { FuelFact, Listing, RecallRecord, VinDecode } from "@/domain/types";
import { autodevByVin, autodevByVdp, autodevSearch, type AutodevDeps } from "@/io/autodev";
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
import { ASSUMPTIONS } from "@/domain/assumptions";
import { autoDevMake, autoDevModel } from "@/domain/vehicle-names";
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
  /** What the confidence label covers (verdict scope — not a silent “High”). */
  confidenceWhy?: string | null;
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
  /** Same walk-away path as Find / sample report when asking price is known. */
  walkAwayUsd: number | null;
  walkAwayLabel: string | null;
  /** Top adjusted comps used for the walk-away (year/trim/miles/price/adjustment + source). */
  similarCars: SimilarCarView[];
  fields: ExtractedListingFields | null;
  provenance: FieldProvenanceRow[];
  vin: string | null;
  vinDecode: VinDecode | null;
  recalls: RecallRecord[];
  recallsAvailable: boolean;
  complaintCount: number | null;
  fuel: FuelFact | null;
  fuelConflict: string | null;
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
  /** Structured How-the-agent-decided trail — only real SERV steps when a live call ran. */
  agentVerdict: AgentVerdict;
  /**
   * Raw SERV decide/challenge traces when attempted (model, timestamp, response id, raw text).
   * Null when no key, gates withheld before spend, or no HTTP was dispatched.
   */
  servTrace: ShopperServTrace | null;
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
      /** Always false on refusal — UI can show "no credit charged" without guessing. */
      creditCharged?: false;
      /** Hint the client to focus the VIN field after a walled fetch. */
      focusVin?: boolean;
      urlHints?: ListingUrlHints;
    };

function blockedFetchRefusal(
  url: string,
  extractedMessage?: string | null,
): Extract<CheckRunResult, { ok: false }> {
  const hints = listingUrlHints(url);
  const summary = listingUrlHintsSummary(hints);
  const wall = (extractedMessage?.trim() ||
    "This listing site blocked our fetch (login or anti-bot wall).")
    // Drop recovery boilerplate from the fetcher — we append a single clear next step.
    .replace(/\s*Keep this URL,?\s*then paste the listing text or enter the VIN\.?/i, "")
    .replace(/\s*Keep the URL,?\s*then paste the listing text or enter the VIN\.?/i, "")
    .trim();
  return {
    ok: false,
    status: 422,
    error: "listing_fetch_blocked",
    message: `${wall} We do not bypass captchas or login walls. ${summary} No credit or free check was used. Paste the listing text or enter the VIN to continue.`,
    blocked: true,
    alternatives: ["paste_text", "enter_vin"],
    creditCharged: false,
    focusVin: true,
    urlHints: hints,
  };
}

async function tryAutodevVdpFallback(
  url: string,
  deps: CheckRunDeps,
  optionalZip?: string | null,
): Promise<CheckRunResult | null> {
  if (!deps.autodevKey || !deps.autodev) return null;
  const hints = listingUrlHints(url);
  const fetchImpl = deps.fetch ?? fetch;
  const found = await autodevByVdp(
    url,
    { year: hints.ymm?.year, make: hints.ymm?.make, model: hints.ymm?.model },
    {
      fetch: fetchImpl,
      cache: deps.autodev.cache,
      counter: deps.autodev.counter,
      apiKey: deps.autodevKey,
      now: deps.now,
      reserve: deps.autodev.reserve,
      signal: deps.autodev.signal,
      timeoutMs: deps.autodev.timeoutMs,
    },
  );
  if (!found.ok) return null;
  const fields = extractedFieldsFromFeedListing(found.listing);
  return buildListingVerdict(fields, {
    url: found.listing.vdp ?? url,
    optionalZip,
    llmUsed: false,
    pageText: null,
    deps,
  });
}

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
  const make = autoDevMake(input.make);
  const model = autoDevModel(input.model);
  const zip = input.zip?.replace(/\D/g, "").slice(0, 5) || undefined;
  const yearMin = Math.max(1981, input.year - GENERATION_YEAR_WINDOW);
  const yearMax = Math.min(new Date().getUTCFullYear() + 1, input.year + GENERATION_YEAR_WINDOW);
  const yearRange = `${yearMin}-${yearMax}`;
  const deps = {
    fetch: input.fetchImpl,
    cache: input.deps.autodev.cache,
    counter: input.deps.autodev.counter,
    apiKey: input.deps.autodevKey,
    now: input.deps.now,
    reserve: input.deps.autodev.reserve,
    signal: input.deps.autodev.signal,
    timeoutMs: input.deps.autodev.timeoutMs,
  };

  // Prefer a wide local radius (same window as Resale). Fall back nationwide when thin.
  const local = zip
    ? await autodevSearch(
        {
          make,
          model,
          yearRange,
          zip,
          distanceMiles: 500,
          limit: 24,
          used: true,
        },
        deps,
      )
    : null;

  let listings = local?.ok ? local.listings : [];
  let scope = zip
    ? `Same ${make} ${model}, within ${GENERATION_YEAR_WINDOW} model years, within 500 miles of ZIP ${zip}`
    : `Same ${make} ${model}, within ${GENERATION_YEAR_WINDOW} model years (nationwide)`;

  const pricedPeers = listings.filter((row) => row.priceUsd != null && row.miles != null).length;
  if (!zip || pricedPeers < ASSUMPTIONS.minComps) {
    const nationwide = await autodevSearch(
      {
        make,
        model,
        yearRange,
        limit: 24,
        used: true,
      },
      deps,
    );
    if (nationwide.ok && nationwide.listings.length > listings.length) {
      listings = nationwide.listings;
      scope = `Same ${make} ${model}, within ${GENERATION_YEAR_WINDOW} model years (nationwide — local inventory was thin)`;
    } else if (!zip && nationwide.ok) {
      listings = nationwide.listings;
    } else if (!local?.ok && !nationwide.ok) {
      return {
        listings: [],
        scope: nationwide.message || local?.message || "Listings search failed",
        sample: false,
      };
    }
  }

  return { listings, scope, sample: false };
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

async function attachCheckShopperServ(input: {
  codeTrail: AgentVerdict;
  subject: Listing;
  verdict: CheckVerdictLabel;
  badge: PriceBadge | null;
  fairValueUsd: number | null;
  priceGap: number | null;
  redFlags: CheckRedFlag[];
  questions: string[];
  similarCars: SimilarCarView[];
  recalls: RecallRecord[];
  recallsAvailable: boolean;
  complaintCount: number | null;
  fuel: FuelFact | null;
  vinDecode: VinDecode | null;
  summary: string;
  unknown: string[];
  sample: boolean;
  compScope: string;
  userLookup: string;
  deps: CheckRunDeps;
}): Promise<{ agentVerdict: AgentVerdict; servTrace: ShopperServTrace | null }> {
  if (!input.deps.servKey?.trim()) {
    return { agentVerdict: input.codeTrail, servTrace: null };
  }

  const reportVerdict =
    input.verdict === "dossier" || input.verdict === "insufficient_data"
      ? ("insufficient_data" as const)
      : input.verdict;

  const report = buildCheckComputedReport({
    subject: input.subject,
    verdict: reportVerdict,
    badge: input.badge,
    fairValueUsd: input.fairValueUsd,
    priceGap: input.priceGap,
    redFlags: input.redFlags,
    questions: input.questions,
    similarCars: input.similarCars,
    recalls: input.recalls,
    recallsAvailable: input.recallsAvailable,
    complaintCount: input.complaintCount,
    fuel: input.fuel,
    vinDecode: input.vinDecode,
    summary: input.summary,
    unknown: input.unknown,
    sample: input.sample,
    compScope: input.compScope,
  });

  const shopper = await runShopperVerdictServ({
    report,
    userLookup: input.userLookup,
    servKey: input.deps.servKey,
    servBaseUrl: input.deps.servBaseUrl,
    model: input.deps.servModel,
    fetchImpl: input.deps.fetch ?? fetch,
    screeningConfidence: input.codeTrail.confidence,
  });

  if (shopper.decision.gateRun.withheld) {
    const why =
      shopper.decision.withholdReason?.trim() ||
      "Not enough priced evidence (ask, miles, or similar cars) for an agent buy/negotiate/pass call.";
    return {
      agentVerdict: emptyAgentVerdict({
        ...input.codeTrail,
        unknowns: [...input.codeTrail.unknowns, why].slice(0, 8),
        serv_spend: {
          calls: 0,
          costNote: `No agent verdict — ${why}`,
        },
        no_serv_step: true,
      }),
      servTrace: null,
    };
  }

  return { agentVerdict: shopper.agentVerdict, servTrace: shopper.trace };
}

function verdictFromBadge(
  badge: PriceBadge | null,
  flags: CheckRedFlag[],
): { verdict: CheckVerdictLabel; label: string } {
  if (flags.some((f) => f.id === "sold")) {
    return { verdict: "walk_away", label: "Pass — listing marked SOLD" };
  }
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
    const vinFromPage =
      (fields.vin.value && isValidVin(fields.vin.value) ? fields.vin.value : null) ??
      (input.url ? extractVin(input.url) : null);
    if (vinFromPage) {
      return buildVinDossier(vinFromPage, input.deps, input.optionalZip);
    }
    return {
      ok: false,
      status: 422,
      error: "insufficient_listing_data",
      message:
        "We could not read enough from that listing (year, make, and model are still unknown). Keep the URL, then paste the listing text or enter the VIN.",
      blocked: true,
      alternatives: ["paste_text", "enter_vin"],
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

  // Prefer government VIN-decoder fuel over listing JSON-LD when they conflict.
  const decodeFuel = gov.vinDecode?.fuel ?? null;
  const listingFuel = fields.fuel.value;
  const fuelNote = fuelConflictNote(listingFuel, decodeFuel);
  if (fuelNote && decodeFuel) {
    fields = {
      ...fields,
      fuel: { value: decodeFuel, source: "vin_decode" },
    };
    subject = { ...subject, fuel: decodeFuel };
  }

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
  if (fuelNote) {
    flags.push({
      id: "fuel_conflict",
      level: "caution",
      text: fuelNote,
      source: "vin-fuel",
    });
  }

  const soldFlag = flags.some((f) => f.id === "sold");
  const parkIt = gov.recalls.some((r) => r.parkIt);
  const parkOutside = gov.recalls.some((r) => r.parkOutSide);
  let questions = dealerQuestions({
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
  if (soldFlag) {
    questions = [
      "Confirm with the seller that this exact VIN is still for sale before planning a visit or deposit.",
      ...questions,
    ];
  }

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
            sourceUrl: subject.vdp,
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
            sourceUrl: row.vdp,
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
    compCount: badge.sampleSize ?? readiness?.offer.compCount ?? 0,
    listingSourceCount: provenanceRows(fields).filter((row) => row.value != null).length,
  });

  const knownIssues = knownModelYearIssues({
    year: subject.year,
    make: subject.make,
    model: subject.model,
    complaintCount: gov.complaintCount,
    recallCount: gov.recallsAvailable ? gov.recalls.length : null,
  });

  const stop = flags.some((f) => f.level === "stop");
  const summary = joinSummarySentences([
    `${subject.year} ${subject.make} ${subject.model}${subject.trim ? ` ${subject.trim}` : ""}`,
    soldFlag
      ? "This listing is marked SOLD — treat it as unavailable until the seller confirms otherwise"
      : null,
    badge?.deltaLabel ?? "Price could not be rated from similar listings",
    stop
      ? "At least one stop-level red flag needs attention before you buy"
      : "Review the red flags and seller questions below",
  ].filter((part): part is string => Boolean(part)));

  const topComps = (readiness?.offer.similarCars ?? []).slice(0, 8);
  const unknown = unknownList(fields, [
    "Paid vehicle history (Carfax/AutoCheck/NMVTIS) was not run",
  ]);
  const fairValueUsd = badge.fairValueUsd ?? readiness?.offer.fairMidUsd ?? null;
  const priceGap =
    badge.fairValueUsd != null && subject.priceUsd != null && badge.fairValueUsd > 0
      ? (subject.priceUsd - badge.fairValueUsd) / badge.fairValueUsd
      : null;
  const listingConfidenceWhy =
    badge.tone !== "unknown" && (badge.sampleSize ?? 0) > 0
      ? `Verdict confidence from ${badge.sampleSize} similar listings plus listing and public-record evidence.`
      : subject.priceUsd != null
        ? "Verdict confidence is limited — an ask was found but similar listings were too thin for a firm price rating."
        : "Covers listing and public-record screening only — not a price rating (no asking price).";
  const codeTrail = buildCheckAgentVerdict({
    kind: "listing",
    title: `${subject.year} ${subject.make} ${subject.model}`,
    verdictLabel: decided.label,
    confidence,
    confidenceWhy: listingConfidenceWhy,
    summary,
    compCount: badge.sampleSize ?? 0,
    fairValueUsd: badge.fairValueUsd,
    hasAsk: subject.priceUsd != null,
    recallsAvailable: gov.recallsAvailable,
    recallCount: gov.recalls.length,
    complaintCount: gov.complaintCount,
    hasVin: Boolean(fields.vin.value),
    redFlagCount: flags.length,
    unknown,
  });
  const shopper = await attachCheckShopperServ({
    codeTrail,
    subject,
    verdict: decided.verdict,
    badge,
    fairValueUsd,
    priceGap,
    redFlags: flags,
    questions,
    similarCars: topComps,
    recalls: gov.recalls,
    recallsAvailable: gov.recallsAvailable,
    complaintCount: gov.complaintCount,
    fuel: gov.fuel,
    vinDecode: gov.vinDecode,
    summary,
    unknown,
    sample: comps.sample,
    compScope: comps.scope,
    userLookup: input.url ?? subject.vin ?? `${subject.year} ${subject.make} ${subject.model}`,
    deps: input.deps,
  });

  return {
    ok: true,
    result: {
      kind: "listing",
      title: `${subject.year} ${subject.make} ${subject.model}`,
      verdict: decided.verdict,
      verdictLabel: decided.label,
      confidence,
      confidenceWhy: listingConfidenceWhy,
      summary,
      badge,
      fairValueUsd,
      priceGap,
      compCount: badge.sampleSize ?? readiness?.offer.compCount ?? 0,
      compScope: comps.scope,
      redFlags: flags,
      questions,
      otd: readiness?.otd ?? null,
      otdNeedsZip: !zipPick.zip && subject.priceUsd != null,
      walkAwayUsd: readiness?.offer.walkAwayUsd ?? null,
      walkAwayLabel: readiness?.offer.walkAwayLabel ?? null,
      similarCars: topComps,
      fields,
      provenance: provenanceRows(fields),
      vin: fields.vin.value,
      vinDecode: gov.vinDecode,
      recalls: gov.recalls,
      recallsAvailable: gov.recallsAvailable,
      complaintCount: gov.complaintCount,
      fuel: gov.fuel,
      fuelConflict: fuelNote,
      safetySummary: gov.safetySummary,
      knownIssues,
      unknown,
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
      agentVerdict: shopper.agentVerdict,
      servTrace: shopper.servTrace,
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

  const feed = listingsForVin[0] ?? null;
  let subject: Listing = feed
    ? {
        ...feed,
        year: feed.year || stub.year,
        make: feed.make || stub.make,
        model: feed.model || stub.model,
        trim: feed.trim ?? stub.trim,
        // Prefer typed ZIP when the feed has none.
        zip: stub.zip || feed.zip,
        // Feed price is feed_only — a VDP URL alone is not seller-page access.
        askingPriceKind: feed.priceUsd != null ? (feed.askingPriceKind ?? "purchase_ask") : feed.askingPriceKind ?? null,
        askingPriceProvenance:
          feed.priceUsd != null ? (feed.askingPriceProvenance ?? "feed_only") : feed.askingPriceProvenance ?? null,
        askingPriceSellerPageAccess: feed.askingPriceSellerPageAccess ?? "not_attempted",
      }
    : stub;

  const hasAsk = subject.priceUsd != null && subject.priceUsd > 0;
  const hasMiles = subject.miles != null && subject.miles >= 0;

  const bundle = await govBundle(vin, subject, gov);
  const knownIssues = knownModelYearIssues({
    year: subject.year,
    make: subject.make,
    model: subject.model,
    complaintCount: bundle.complaintCount,
    recallCount: bundle.recallsAvailable ? bundle.recalls.length : null,
  });

  const redFlags: CheckRedFlag[] = bundle.recalls.some((r) => r.parkIt)
    ? [
        {
          id: "park_it",
          level: "stop",
          text: "NHTSA lists a park-it (do not drive) campaign for this model year. Verify VIN applicability before driving.",
          source: "nhtsa-recalls",
        },
      ]
    : [];

  let badge: PriceBadge | null = null;
  let compsScope = hasAsk
    ? "Looking up similar listings for this VIN’s current ask"
    : "VIN check has no asking price yet — price rating needs a current listing ask";
  let compsSample = false;
  let pool: Listing[] = feed ? [subject] : [];
  let readiness: PurchaseReadiness | null = null;
  let topComps: SimilarCarView[] = [];

  if (hasAsk && hasMiles) {
    const zip = subject.zip?.replace(/\D/g, "").slice(0, 5) || null;
    const comps = await searchComps({
      make: subject.make,
      model: subject.model,
      year: subject.year,
      zip,
      deps,
      fetchImpl,
    });
    compsScope = comps.scope;
    compsSample = comps.sample;
    pool =
      comps.listings.length > 0
        ? comps.listings.some((row) => row.vin === subject.vin)
          ? comps.listings
          : [subject, ...comps.listings]
        : [subject];
    badge = priceBadge(subject, pool, { decodedTrim: decode.trim ?? subject.trim });
    const zipPick = zipChoice(null, zip);
    readiness = buildPurchaseReadiness({
      car: {
        vin: subject.vin,
        year: subject.year,
        make: subject.make,
        model: subject.model,
        trim: subject.trim,
        priceUsd: subject.priceUsd!,
        miles: subject.miles,
        accidentCount: subject.accidentCount,
        askingPriceKind: subject.askingPriceKind ?? "purchase_ask",
        zip: zipPick.zip,
        sourceUrl: subject.vdp,
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
        sourceUrl: row.vdp,
      })),
      zip: zipPick.zip,
      zipUsedFor: zipPick.zipUsedFor,
      now: deps.now ?? new Date(),
      recallCampaignCount: bundle.recallsAvailable ? bundle.recalls.length : null,
    });
    topComps = (readiness.offer.similarCars ?? []).slice(0, 8);
  }

  const questions = dealerQuestions({
    listing: subject,
    recalls: bundle.recalls,
    parkIt: bundle.recalls.some((r) => r.parkIt),
    parkOutside: bundle.recalls.some((r) => r.parkOutSide),
    historyMissing: subject.accidentCount === null || subject.ownerCount === null,
  });

  const unknown: string[] = [
    "Paid vehicle history (Carfax/AutoCheck/NMVTIS) was not run",
    "Title brand status from a paid report",
  ];
  if (!hasAsk) unknown.unshift("Asking price (no current listing ask for this VIN)");
  if (!hasMiles) unknown.unshift("Mileage (no current listing mileage for this VIN)");
  if (!listingsForVin.length) unknown.push("Current dealer listings for this VIN");

  const parkIt = bundle.recalls.some((row) => row.parkIt);
  const priced = Boolean(badge && badge.tone !== "unknown" && badge.fairValueUsd != null);
  const decided = hasAsk
    ? verdictFromBadge(badge, redFlags)
    : { verdict: "dossier" as const, label: "VIN dossier (free sources)" };

  // Confidence describes the screening verdict — not “gov records alone while unpriced = High”.
  let confidence: CheckConfidence;
  let confidenceWhy: string;
  if (priced) {
    const comps = badge?.sampleSize ?? 0;
    confidence = comps >= 8 ? "High" : comps >= ASSUMPTIONS.minComps ? "Medium" : "Low";
    confidenceWhy = `Verdict confidence from ${comps} similar listings plus public records (not a paid history report).`;
  } else if (hasAsk) {
    confidence = "Low";
    confidenceWhy =
      "Verdict confidence is low: an asking price was found, but similar listings were too thin for a price rating.";
  } else {
    const safetyKnown = bundle.safetySummary != null && !/unavailable/i.test(bundle.safetySummary);
    const recordCount = [bundle.recallsAvailable, bundle.complaintCount != null, safetyKnown].filter(Boolean).length;
    confidence = recordCount >= 2 ? "Medium" : "Low";
    confidenceWhy =
      "Covers public-record identity and safety only — not a buy/negotiate/pass or price rating (no asking price).";
  }

  const askLine = hasAsk
    ? feed?.dealer
      ? `Ask $${subject.priceUsd!.toLocaleString("en-US")} at ${feed.dealer}${
          feed.city || feed.state ? ` (${[feed.city, feed.state].filter(Boolean).join(", ")})` : ""
        } (from data feed listing) — used for price rating.`
      : `Ask $${subject.priceUsd!.toLocaleString("en-US")} (from data feed listing) — used for price rating.`
    : "No current listing ask for this VIN, so this car is not price-rated.";

  const summary = [
    `VIN dossier for ${subject.year} ${subject.make} ${subject.model}${subject.trim ? ` ${subject.trim}` : ""}.`,
    parkIt
      ? "A model-year park-it campaign is on file. Do not treat this VIN as cleared to drive until applicability and repair are confirmed."
      : bundle.recallsAvailable
        ? bundle.recalls.length === 0
          ? "No recall campaigns were listed for this model year. That is not a VIN-specific repair check."
          : `${bundle.recalls.length} model-year recall campaign${bundle.recalls.length === 1 ? "" : "s"} are on file. Repair status for this exact VIN is still unknown.`
        : "Recall campaigns could not be checked.",
    askLine,
    priced ? badge?.deltaLabel ?? null : hasAsk ? "Similar listings were too thin to publish a fair value." : null,
    listingsForVin.length
      ? `Found ${listingsForVin.length} current listing${listingsForVin.length === 1 ? "" : "s"} for this VIN.`
      : "No current dealer listing for this VIN was returned.",
    "This is not a paid history report.",
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ");

  const fairValueUsd = badge?.fairValueUsd ?? readiness?.offer.fairMidUsd ?? null;
  const priceGap =
    fairValueUsd != null && subject.priceUsd != null && fairValueUsd > 0
      ? (subject.priceUsd - fairValueUsd) / fairValueUsd
      : null;
  const compCount = badge?.sampleSize ?? readiness?.offer.compCount ?? 0;

  const codeTrail = buildCheckAgentVerdict({
    kind: "vin_dossier",
    title: `${subject.year} ${subject.make} ${subject.model}`,
    verdictLabel: decided.label,
    confidence,
    confidenceWhy,
    summary,
    compCount,
    fairValueUsd,
    hasAsk,
    recallsAvailable: bundle.recallsAvailable,
    recallCount: bundle.recalls.length,
    complaintCount: bundle.complaintCount,
    hasVin: true,
    redFlagCount: redFlags.length,
    unknown,
  });

  // When ask + miles + comps exist, OpenServ decide+challenge runs (same gates as listing Check).
  const shopper = await attachCheckShopperServ({
    codeTrail,
    subject,
    verdict: decided.verdict,
    badge,
    fairValueUsd,
    priceGap,
    redFlags,
    questions,
    similarCars: topComps,
    recalls: bundle.recalls,
    recallsAvailable: bundle.recallsAvailable,
    complaintCount: bundle.complaintCount,
    fuel: bundle.fuel,
    vinDecode: bundle.vinDecode ?? decode,
    summary,
    unknown,
    sample: compsSample,
    compScope: compsScope,
    userLookup: vin,
    deps,
  });

  const provenance: FieldProvenanceRow[] = [
    { field: "vin", value: vin, source: "typed VIN" },
    { field: "year", value: subject.year, source: "government VIN decoder" },
    { field: "make", value: subject.make, source: "government VIN decoder" },
    { field: "model", value: subject.model, source: "government VIN decoder" },
  ];
  if (hasAsk) {
    provenance.push({
      field: "priceUsd",
      value: subject.priceUsd,
      source: "listed price from data feed",
    });
  }
  if (hasMiles) {
    provenance.push({
      field: "miles",
      value: subject.miles,
      source: "listed price from data feed",
    });
  }
  if (feed?.dealer) {
    provenance.push({ field: "sellerName", value: feed.dealer, source: "listed price from data feed" });
  }

  return {
    ok: true,
    result: {
      kind: "vin_dossier",
      title: `${subject.year} ${subject.make} ${subject.model}`,
      verdict: decided.verdict,
      verdictLabel: decided.label,
      confidence,
      confidenceWhy,
      summary,
      badge,
      fairValueUsd,
      priceGap,
      compCount,
      compScope: compsScope,
      redFlags,
      questions,
      otd: readiness?.otd ?? null,
      otdNeedsZip: hasAsk && !subject.zip,
      walkAwayUsd: readiness?.offer.walkAwayUsd ?? null,
      walkAwayLabel: readiness?.offer.walkAwayLabel ?? null,
      similarCars: topComps,
      fields: null,
      provenance,
      vin,
      vinDecode: bundle.vinDecode ?? decode,
      recalls: bundle.recalls,
      recallsAvailable: bundle.recallsAvailable,
      complaintCount: bundle.complaintCount,
      fuel: bundle.fuel,
      fuelConflict: null,
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
      agentVerdict: shopper.agentVerdict,
      servTrace: shopper.servTrace,
      llmUsed: false,
      sample: compsSample,
    },
  };
}

const CHECK_SERV_CALL_BUDGET = 2;

/** One Check may spend at most decide + challenge. Further SERV HTTP gets a local refusal. */
function boundServFetch(deps: CheckRunDeps): CheckRunDeps {
  const inner = deps.fetch ?? fetch;
  const left = { n: CHECK_SERV_CALL_BUDGET };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const servCall = isServEndpointUrl(url, deps.servBaseUrl);
    if (servCall) {
      if (left.n <= 0) {
        return new Response(JSON.stringify({ error: "check_serv_budget" }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      }
      left.n -= 1;
    }
    return inner(input, init);
  };
  return { ...deps, fetch: fetchImpl };
}

export async function runCheck(input: CheckRunInput, deps: CheckRunDeps = {}): Promise<CheckRunResult> {
  const bounded = boundServFetch(deps);
  if (input.kind === "vin") {
    return buildVinDossier(input.vin.trim().toUpperCase(), bounded, input.optionalZip);
  }

  if (input.kind === "paste") {
    const extracted = await extractFromPastedText(input.text, bounded, input.url);
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
      deps: bounded,
    });
  }

  const extracted = await extractFromListingUrl(input.url, bounded);
  if (!extracted.ok) {
    if (extracted.blocked) {
      // URL-only evidence first — never bypass the wall.
      const hints = listingUrlHints(input.url);
      if (hints.vin) {
        return buildVinDossier(hints.vin, deps, input.optionalZip);
      }
      // Legitimate Auto.dev VDP / YMM+exact-VDP lookup when the API can match.
      const feed = await tryAutodevVdpFallback(input.url, deps, input.optionalZip);
      if (feed?.ok) return feed;
      return blockedFetchRefusal(input.url, extracted.message);
    }
    return {
      ok: false,
      status: 400,
      error: extracted.error,
      message: extracted.message,
    };
  }

  // Thin page: prefer VIN path when a VIN is on the page or in the URL.
  const hasYmm =
    extracted.fields.year.value != null &&
    Boolean(extracted.fields.make.value) &&
    Boolean(extracted.fields.model.value);
  if (!hasYmm) {
    const vinFallback =
      (extracted.fields.vin.value && isValidVin(extracted.fields.vin.value)
        ? extracted.fields.vin.value
        : null) ?? extractVin(extracted.fetch?.finalUrl ?? input.url);
    if (vinFallback) {
      return buildVinDossier(vinFallback, deps, input.optionalZip);
    }
    const feed = await tryAutodevVdpFallback(input.url, deps, input.optionalZip);
    if (feed?.ok) return feed;
    const thin = blockedFetchRefusal(
      input.url,
      "We fetched the page but could not read a usable year, make, and model.",
    );
    return { ...thin, error: "listing_fetch_thin" };
  }

  return buildListingVerdict(extracted.fields, {
    url: extracted.fetch?.finalUrl ?? input.url,
    optionalZip: input.optionalZip,
    llmUsed: extracted.llmUsed,
    pageText: extracted.parse.llmText,
    deps: bounded,
  });
}
