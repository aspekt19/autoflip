/**
 * Free public government decision-input port (NHTSA + FuelEconomy.gov).
 * Families: vPIC DecodeVinValues, recallsByVehicle, complaintsByVehicle, NCAP SafetyRatings,
 * and FuelEconomy.gov menu/vehicle/fuelprices (Find free_gov_fuel).
 * Title / NMVTIS / total-loss remain unknown_not_connected. Never fabricates clean title.
 * Never claims VIN-specific unrepaired/open recall status from make/model/year campaigns.
 * Fuel matches that are ambiguous stay a labeled range — never a silent single pick.
 */
import { TtlCache } from "@/io/cache";
import {
  complaintsFor,
  decodeVin,
  recallsFor,
  type GovDeps,
} from "@/io/gov";
import { safetyRatingsFor } from "@/io/nhtsa-safety";
import {
  lookupFindFuelEvidence,
  type FindFuelEvidence,
} from "@/domain/find-fuel-match";
import type { Listing } from "@/domain/types";
import type { EvidenceFact, ScoutToolId } from "./types";

export const FREE_GOV_TIMEOUT_MS = 12_000;
/** Bounded cache for free public endpoints (demo engineering policy, not provider TTL). */
export const FREE_GOV_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const FREE_GOV_RATE_NOTE =
  "Free public NHTSA VIN decode/recalls/complaints/SafetyRatings + FuelEconomy.gov — no API key; polite sequential calls; 12s timeout; 6h process cache.";

/** Free decision-input tools for Find (and Scout port reuse). */
export type FreeGovToolId =
  | "evidence.gov_recalls"
  | "evidence.gov_vpic"
  | "evidence.gov_safety"
  | "evidence.gov_fuel";

export type FreeGovLookupStatus = "ok" | "empty" | "unavailable" | "error";

export type FreeGovEvidencePacket = {
  toolId: FreeGovToolId;
  status: FreeGovLookupStatus;
  cached: boolean;
  fetchedAt: string;
  scope: string;
  url: string | null;
  timeoutMs: number;
  rateNote: string;
  limitsNote: string;
  facts: EvidenceFact[];
  summary: string;
  outcomeOk: boolean;
  outcomeStatus: "success" | "empty" | "failed" | "unsupported";
  outcomeCapability: "supported_executed" | "empty" | "failed" | "unsupported";
  /** Structured fuel evidence when toolId is evidence.gov_fuel. */
  fuelEvidence?: FindFuelEvidence | null;
};

/** Process-global free-gov cache (survives per-request port construction). */
const globalFreeGov = globalThis as unknown as {
  __autoflipFreeGovCache?: TtlCache<FreeGovEvidencePacket>;
};

export function freeGovProcessCache(): TtlCache<FreeGovEvidencePacket> {
  if (!globalFreeGov.__autoflipFreeGovCache) {
    globalFreeGov.__autoflipFreeGovCache = new TtlCache<FreeGovEvidencePacket>(FREE_GOV_CACHE_TTL_MS);
  }
  return globalFreeGov.__autoflipFreeGovCache;
}

export type ScoutFreeGovPort = {
  run(toolId: FreeGovToolId, listing: Listing): Promise<FreeGovEvidencePacket>;
};

export function isFreeGovToolId(id: string): id is FreeGovToolId {
  return (
    id === "evidence.gov_recalls" ||
    id === "evidence.gov_vpic" ||
    id === "evidence.gov_safety" ||
    id === "evidence.gov_fuel"
  );
}

function metaFact(
  toolId: FreeGovToolId,
  packet: {
    status: FreeGovLookupStatus;
    scope: string;
    url: string | null;
    fetchedAt: string;
    cached: boolean;
    timeoutMs: number;
    value: unknown;
    note: string;
    kind: EvidenceFact["kind"];
  },
): EvidenceFact {
  return {
    key: toolId,
    value: {
      status: packet.status,
      scope: packet.scope,
      url: packet.url,
      fetchedAt: packet.fetchedAt,
      cached: packet.cached,
      timeoutMs: packet.timeoutMs,
      ...(packet.value && typeof packet.value === "object" ? (packet.value as object) : { detail: packet.value }),
    },
    kind: packet.kind,
    source: "gov",
    note: packet.note,
  };
}

/** Harness: honest unsupported (offline autonomy tests). */
export function unsupportedFreeGovPort(): ScoutFreeGovPort {
  return {
    async run(toolId) {
      const fetchedAt = new Date().toISOString();
      return {
        toolId,
        status: "unavailable",
        cached: false,
        fetchedAt,
        scope: "harness_unsupported — free gov port not wired in this test",
        url: null,
        timeoutMs: FREE_GOV_TIMEOUT_MS,
        rateNote: FREE_GOV_RATE_NOTE,
        limitsNote: "Test harness — no public HTTP.",
        facts: [
          {
            key: toolId,
            value: { status: "unsupported" },
            kind: "unknown",
            source: "gov",
            note: "UNSUPPORTED: gov lookup not executed in this harness. Not a successful evidence fetch. Title/NMVTIS remain unknown.",
          },
        ],
        summary: `${toolId} unsupported — not treated as successful evidence or cache-success.`,
        outcomeOk: false,
        outcomeStatus: "unsupported",
        outcomeCapability: "unsupported",
      };
    },
  };
}

export function createLiveFreeGovPort(opts?: {
  fetch?: typeof fetch;
  cache?: TtlCache<FreeGovEvidencePacket>;
  now?: () => Date;
  /** Shopper note — used for city-heavy fuel assumptions on evidence.gov_fuel. */
  shopperNote?: string | null;
}): ScoutFreeGovPort {
  const fetchImpl = opts?.fetch ?? fetch;
  // Default: fresh cache (test isolation). Live Find/Scout must pass freeGovProcessCache().
  const cache = opts?.cache ?? new TtlCache<FreeGovEvidencePacket>(FREE_GOV_CACHE_TTL_MS);
  const now = opts?.now ?? (() => new Date());
  const deps: GovDeps = { fetch: fetchImpl };
  const shopperNote = opts?.shopperNote ?? null;
  const cityHeavyBit = /\bmostly\s+city\b|\bcity\s+driving\b|\bcity[\s-]?heavy\b|\bmainly\s+city\b/i.test(
    shopperNote ?? "",
  )
    ? "cityheavy"
    : "defaultmix";

  return {
    async run(toolId, listing) {
      const fetchedAt = now().toISOString();
      // Include shopper mix + listing trim/engine/drive so fuel cache does not collide.
      const fuelHints =
        toolId === "evidence.gov_fuel"
          ? `:${cityHeavyBit}:${listing.trim ?? ""}:${listing.engine ?? ""}:${listing.drivetrain ?? ""}`
          : "";
      const cacheKey =
        `${toolId}:${listing.vin}:${listing.year}:${listing.make}:${listing.model}${fuelHints}`.toLowerCase();
      const hit = cache.get(cacheKey, now().getTime());
      if (hit) {
        return {
          ...hit,
          cached: true,
          fetchedAt,
          summary: `${hit.summary} (cached)`,
        };
      }

      let packet: FreeGovEvidencePacket;
      try {
        if (toolId === "evidence.gov_recalls") {
          packet = await runRecalls(listing, deps, fetchedAt);
        } else if (toolId === "evidence.gov_vpic") {
          packet = await runVpic(listing, deps, fetchedAt);
        } else if (toolId === "evidence.gov_fuel") {
          packet = await runFuel(listing, deps, fetchedAt, shopperNote);
        } else {
          packet = await runSafety(listing, deps, fetchedAt);
        }
      } catch {
        packet = {
          toolId,
          status: "error",
          cached: false,
          fetchedAt,
          scope: "free_gov_exception",
          url: null,
          timeoutMs: FREE_GOV_TIMEOUT_MS,
          rateNote: FREE_GOV_RATE_NOTE,
          limitsNote: "Exception during free public lookup.",
          facts: [
            {
              key: toolId,
              value: { status: "error", titleNmvtis: "unknown_not_connected" },
              kind: "unknown",
              source: "gov",
              note: "Free gov lookup failed — unavailable (not a clean-title claim).",
            },
          ],
          summary: `${toolId} failed — treating as unavailable.`,
          outcomeOk: false,
          outcomeStatus: "failed",
          outcomeCapability: "failed",
        };
      }

      if (packet.status === "ok" || packet.status === "empty") {
        cache.set(cacheKey, { ...packet, cached: false }, now().getTime());
      }
      return packet;
    },
  };
}

async function runRecalls(listing: Listing, deps: GovDeps, fetchedAt: string): Promise<FreeGovEvidencePacket> {
  const params = new URLSearchParams({
    make: listing.make,
    model: listing.model,
    modelYear: String(listing.year),
  });
  const url = `https://api.nhtsa.gov/recalls/recallsByVehicle?${params.toString()}`;
  const scope =
    "nhtsa_recalls+complaints_by_make_model_year — campaigns/allegations for the vehicle configuration; NOT VIN-specific unrepaired/open status; NOT title/NMVTIS; zero campaigns ≠ VIN clear";
  const [recalls, complaints] = await Promise.all([
    recallsFor(listing.make, listing.model, listing.year, deps),
    complaintsFor(listing.make, listing.model, listing.year, deps),
  ]);

  if (!recalls.available && !complaints.available) {
    return {
      toolId: "evidence.gov_recalls",
      status: "unavailable",
      cached: false,
      fetchedAt,
      scope,
      url,
      timeoutMs: FREE_GOV_TIMEOUT_MS,
      rateNote: FREE_GOV_RATE_NOTE,
      limitsNote: "Upstream missing/malformed — distinct from zero campaigns.",
      facts: [
        metaFact("evidence.gov_recalls", {
          status: "unavailable",
          scope,
          url,
          fetchedAt,
          cached: false,
          timeoutMs: FREE_GOV_TIMEOUT_MS,
          value: {
            recallsAvailable: false,
            complaintsAvailable: false,
            titleNmvtis: "unknown_not_connected",
            vinOpenRecalls: null,
          },
          kind: "unknown",
          note: "NHTSA recalls/complaints unavailable — not a successful empty result; title/NMVTIS remain unknown; never sets vinOpenRecalls=false.",
        }),
      ],
      summary: "NHTSA recalls/complaints unavailable (not empty-no-record).",
      outcomeOk: false,
      outcomeStatus: "failed",
      outcomeCapability: "failed",
    };
  }

  // parkIt vs parkOutside are DIFFERENT NHTSA semantics — never OR into one do-not-drive flag.
  const parkIt = recalls.records.some((r) => r.parkIt);
  const parkOutside = recalls.records.some((r) => r.parkOutSide);
  const empty = recalls.available && recalls.records.length === 0;
  const flagNote = parkIt
    ? "NHTSA make/model/year campaigns include parkIt=true — configuration-level do-not-drive signal for investigation; not VIN repair proof. parkOutside is tracked separately. Title/NMVTIS unknown."
    : parkOutside
      ? "NHTSA make/model/year campaigns include parkOutside=true (outdoor parking guidance) — NOT a parkIt/do-not-drive claim by itself; not VIN repair proof. Title/NMVTIS unknown."
      : empty
        ? "NHTSA returned zero make/model/year campaigns (available empty). Not VIN unrepaired status; never vinOpenRecalls=false. Title/NMVTIS unknown."
        : "NHTSA make/model/year campaigns recorded. Not VIN-specific unrepaired/open status. Title/NMVTIS unknown.";
  const facts: EvidenceFact[] = [
    {
      key: "evidence.gov_recalls",
      value: {
        status: empty ? "empty" : "ok",
        scope,
        url,
        fetchedAt,
        cached: false,
        timeoutMs: FREE_GOV_TIMEOUT_MS,
        recallCount: recalls.available ? recalls.records.length : null,
        recallsAvailable: recalls.available,
        parkIt,
        parkOutside,
        campaigns: recalls.records.slice(0, 8).map((r) => ({
          campaignNumber: r.campaignNumber,
          component: r.component,
          parkIt: r.parkIt,
          parkOutSide: r.parkOutSide,
          summary: r.summary.slice(0, 240),
        })),
        complaintsAvailable: complaints.available,
        complaintCount: complaints.available ? complaints.count : null,
        complaintsUrl: complaints.url,
        complaintsNote:
          "Model-level owner allegations — not verified defects or VIN crash/damage history; never match partial complaint VINs as proof.",
        titleNmvtis: "unknown_not_connected",
        /** Never invent VIN-open status from make/model/year campaigns. */
        vinOpenRecalls: null,
      },
      kind: "verified",
      source: "gov",
      note: flagNote,
    },
  ];
  if (parkIt) {
    facts.push({
      key: "nhtsa_park_it",
      value: { parkIt: true, parkOutside, scope },
      kind: "verified",
      source: "gov",
      note: "NHTSA parkIt campaign flag present for make/model/year — adverse safety signal for investigation; not a title brand; not VIN unrepaired proof. Distinct from parkOutside.",
    });
  }
  if (parkOutside) {
    facts.push({
      key: "nhtsa_park_outside",
      value: { parkOutside: true, parkIt, scope },
      kind: "verified",
      source: "gov",
      note: "NHTSA parkOutside campaign flag present for make/model/year — outdoor parking guidance only; NOT do-not-drive from this flag alone; not VIN unrepaired proof.",
    });
  }

  return {
    toolId: "evidence.gov_recalls",
    status: empty ? "empty" : "ok",
    cached: false,
    fetchedAt,
    scope,
    url,
    timeoutMs: FREE_GOV_TIMEOUT_MS,
    rateNote: FREE_GOV_RATE_NOTE,
    limitsNote: "Max 8 campaign summaries retained for planner briefs. Complaints are allegations, not VIN events. parkIt ≠ parkOutside.",
    facts,
    summary: empty
      ? `NHTSA recalls empty for ${listing.year} ${listing.make} ${listing.model} (available; not VIN-clear).`
      : `NHTSA recalls ${recalls.records.length} campaign(s); complaints=${complaints.available ? complaints.count : "unavailable"}; parkIt=${parkIt}; parkOutside=${parkOutside}.`,
    outcomeOk: true,
    outcomeStatus: empty ? "empty" : "success",
    outcomeCapability: empty ? "empty" : "supported_executed",
  };
}

/**
 * HTTP 200 is NOT VIN confirmation — inspect ErrorCode/ErrorText.
 * Incomplete / non-zero ErrorCode → unavailable/error; never invent verified decode identity.
 */
async function runVpic(listing: Listing, deps: GovDeps, fetchedAt: string): Promise<FreeGovEvidencePacket> {
  const url = `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(listing.vin)}?format=json`;
  const scope =
    "nhtsa_vpic_DecodeVinValues — VIN decode specs only when ErrorCode=0; not title/NMVTIS/total-loss/history; HTTP 200 alone is not success";

  const vinOk = /^[A-HJ-NPR-Z0-9]{17}$/i.test(listing.vin.trim());
  if (!vinOk) {
    return {
      toolId: "evidence.gov_vpic",
      status: "error",
      cached: false,
      fetchedAt,
      scope,
      url,
      timeoutMs: FREE_GOV_TIMEOUT_MS,
      rateNote: FREE_GOV_RATE_NOTE,
      limitsNote: "Listing VIN must be 17 characters before treating decode as exact identity.",
      facts: [
        {
          key: "evidence.gov_vpic",
          value: {
            status: "invalid_input",
            scope,
            url,
            fetchedAt,
            vinLength: listing.vin.trim().length,
            titleNmvtis: "unknown_not_connected",
          },
          kind: "unknown",
          source: "gov",
          note: "VIN is not 17 characters — vPIC partial decode is not accepted as listing identity. Title/NMVTIS unknown.",
        },
      ],
      summary: "vPIC skipped — VIN not 17 characters (incomplete input).",
      outcomeOk: false,
      outcomeStatus: "failed",
      outcomeCapability: "failed",
    };
  }

  const decoded = await decodeVin(listing.vin, deps);
  if (!decoded) {
    return {
      toolId: "evidence.gov_vpic",
      status: "unavailable",
      cached: false,
      fetchedAt,
      scope,
      url,
      timeoutMs: FREE_GOV_TIMEOUT_MS,
      rateNote: FREE_GOV_RATE_NOTE,
      limitsNote: "vPIC unavailable — listing feed identity not upgraded to verified history.",
      facts: [
        {
          key: "evidence.gov_vpic",
          value: { status: "unavailable", scope, url, fetchedAt, titleNmvtis: "unknown_not_connected" },
          kind: "unknown",
          source: "gov",
          note: "vPIC decode unavailable. Title/NMVTIS/history remain unknown (not clean).",
        },
      ],
      summary: "vPIC VIN decode unavailable.",
      outcomeOk: false,
      outcomeStatus: "failed",
      outcomeCapability: "failed",
    };
  }

  const errorCode = (decoded.errorCode ?? "").trim();
  const errorText = decoded.errorText ?? null;
  // ErrorCode "0" is the only accepted exact-decode success. Any other code (incl. "6 Incomplete VIN") is not identity.
  const decodeOk = errorCode === "0";
  if (!decodeOk) {
    return {
      toolId: "evidence.gov_vpic",
      status: "error",
      cached: false,
      fetchedAt,
      scope,
      url,
      timeoutMs: FREE_GOV_TIMEOUT_MS,
      rateNote: FREE_GOV_RATE_NOTE,
      limitsNote: "Non-zero ErrorCode — do not invent make/model/year identity from partial decode fields.",
      facts: [
        {
          key: "evidence.gov_vpic",
          value: {
            status: "error",
            errorCode: errorCode || null,
            errorText,
            scope,
            url,
            fetchedAt,
            titleNmvtis: "unknown_not_connected",
            // Explicitly omit decoded make/model/year — incomplete decode must not become listing identity.
          },
          kind: "unknown",
          source: "gov",
          note: `vPIC ErrorCode=${errorCode || "missing"} (${errorText ?? "no ErrorText"}) — HTTP success is not VIN confirmation; decode facts not accepted. Title/NMVTIS unknown.`,
        },
      ],
      summary: `vPIC decode rejected (ErrorCode=${errorCode || "missing"}; not exact identity).`,
      outcomeOk: false,
      outcomeStatus: "failed",
      outcomeCapability: "failed",
    };
  }

  return {
    toolId: "evidence.gov_vpic",
    status: "ok",
    cached: false,
    fetchedAt,
    scope,
    url,
    timeoutMs: FREE_GOV_TIMEOUT_MS,
    rateNote: FREE_GOV_RATE_NOTE,
    limitsNote: "Specs only when ErrorCode=0 — never invents title brands or accident history.",
    facts: [
      {
        key: "evidence.gov_vpic",
        value: {
          year: decoded.year,
          make: decoded.make,
          model: decoded.model,
          errorCode: "0",
          errorText,
          scope,
          url,
          fetchedAt,
          titleNmvtis: "unknown_not_connected",
        },
        kind: "verified",
        source: "gov",
        note: "vPIC VIN decode specs recorded (ErrorCode=0). Title/NMVTIS/total-loss remain unknown_not_connected. Missing equipment fields mean NHTSA lacks data, not feature absent.",
      },
    ],
    summary: `vPIC decode ${decoded.year ?? "?"} ${decoded.make ?? "?"} ${decoded.model ?? "?"} (ErrorCode=0).`,
    outcomeOk: true,
    outcomeStatus: "success",
    outcomeCapability: "supported_executed",
  };
}

async function runSafety(listing: Listing, deps: GovDeps, fetchedAt: string): Promise<FreeGovEvidencePacket> {
  const scope =
    "nhtsa_safety_ratings_by_make_model_year — configuration crash ratings; not VIN-specific; Not Rated ≠ 0 stars/pass; RolloverPossibility 0 with Not Rated ≠ 0% risk; not title/NMVTIS";
  const lookup = await safetyRatingsFor(listing.make, listing.model, listing.year, deps);
  if (!lookup.available) {
    return {
      toolId: "evidence.gov_safety",
      status: "unavailable",
      cached: false,
      fetchedAt,
      scope,
      url: lookup.indexUrl,
      timeoutMs: FREE_GOV_TIMEOUT_MS,
      rateNote: FREE_GOV_RATE_NOTE,
      limitsNote: "Index unavailable — distinct from zero rated variants.",
      facts: [
        {
          key: "evidence.gov_safety",
          value: { status: "unavailable", scope, url: lookup.indexUrl, fetchedAt, titleNmvtis: "unknown_not_connected" },
          kind: "unknown",
          source: "gov",
          note: "NHTSA safety ratings unavailable for this make/model/year — unknown, not a clean pass.",
        },
      ],
      summary: "NHTSA safety ratings unavailable.",
      outcomeOk: false,
      outcomeStatus: "failed",
      outcomeCapability: "failed",
    };
  }
  if (lookup.variants.length === 0) {
    return {
      toolId: "evidence.gov_safety",
      status: "empty",
      cached: false,
      fetchedAt,
      scope,
      url: lookup.indexUrl,
      timeoutMs: FREE_GOV_TIMEOUT_MS,
      rateNote: FREE_GOV_RATE_NOTE,
      limitsNote: "Available empty — no rated variants for this MY/make/model.",
      facts: [
        {
          key: "evidence.gov_safety",
          value: {
            status: "empty",
            scope,
            url: lookup.indexUrl,
            fetchedAt,
            variantCount: 0,
            titleNmvtis: "unknown_not_connected",
          },
          kind: "verified",
          source: "gov",
          note: "NHTSA safety ratings index empty for make/model/year (available). Empty ≠ risk-zero pass.",
        },
      ],
      summary: "NHTSA safety ratings empty (available; not a pass).",
      outcomeOk: true,
      outcomeStatus: "empty",
      outcomeCapability: "empty",
    };
  }

  const anyNotRated = lookup.variants.some((v) => v.ratingStatus === "not_rated");
  const anyRated = lookup.variants.some((v) => v.ratingStatus === "rated");
  const ratingAggregate: "rated" | "not_rated" | "mixed" = anyRated && anyNotRated ? "mixed" : anyRated ? "rated" : "not_rated";
  // Facts are verified as "what NHTSA returned" — but not_rated must stay unknown for risk, never a clean pass.
  const factKind: EvidenceFact["kind"] = ratingAggregate === "not_rated" ? "unknown" : "verified";

  return {
    toolId: "evidence.gov_safety",
    status: "ok",
    cached: false,
    fetchedAt,
    scope,
    url: lookup.detailUrl ?? lookup.indexUrl,
    timeoutMs: FREE_GOV_TIMEOUT_MS,
    rateNote: FREE_GOV_RATE_NOTE,
    limitsNote: "Up to 3 VehicleId detail rows. Not Rated and RolloverPossibility:0 sentinel must not be treated as risk-zero.",
    facts: [
      {
        key: "evidence.gov_safety",
        value: {
          status: "ok",
          ratingAggregate,
          scope,
          url: lookup.detailUrl ?? lookup.indexUrl,
          indexUrl: lookup.indexUrl,
          fetchedAt,
          variants: lookup.variants,
          titleNmvtis: "unknown_not_connected",
          warnings: [
            "Not Rated is unknown — never 0 stars or a clean safety pass.",
            "RolloverPossibility 0.0 accompanying Not Rated is a sentinel, not 0% rollover risk.",
            "Configuration ratings are not VIN condition, repair, or title evidence.",
          ],
        },
        kind: factKind,
        source: "gov",
        note:
          ratingAggregate === "not_rated"
            ? "NHTSA SafetyRatings returned Not Rated variant(s) — unknown, not risk-zero. Title/NMVTIS unknown."
            : "NHTSA configuration safety ratings recorded — not VIN-specific crash history; Not Rated fields remain unknown. Title/NMVTIS unknown.",
      },
    ],
    summary:
      ratingAggregate === "not_rated"
        ? `NHTSA safety ratings: ${lookup.variants.length} variant(s); ratingAggregate=not_rated (unknown, not pass).`
        : `NHTSA safety ratings: ${lookup.variants.length} variant(s); ratingAggregate=${ratingAggregate}; overall=${lookup.variants[0]?.overallRating ?? "Not Rated"}.`,
    outcomeOk: true,
    outcomeStatus: "success",
    outcomeCapability: "supported_executed",
  };
}

async function runFuel(
  listing: Listing,
  deps: GovDeps,
  fetchedAt: string,
  shopperNote: string | null,
): Promise<FreeGovEvidencePacket> {
  const scope =
    "fueleconomy_gov_menu_vehicle_fuelprices — year/make/model (+ trim/engine/drive when listed); ambiguous configs stay a labeled range; not full TCO";
  const evidence = await lookupFindFuelEvidence(
    {
      year: listing.year,
      make: listing.make,
      model: listing.model,
      trim: listing.trim,
      engine: listing.engine,
      drivetrain: listing.drivetrain,
    },
    { deps: { fetch: deps.fetch }, note: shopperNote },
  );

  if (evidence.match === "unavailable") {
    return {
      toolId: "evidence.gov_fuel",
      status: "unavailable",
      cached: false,
      fetchedAt,
      scope,
      url: evidence.sourceUrl,
      timeoutMs: FREE_GOV_TIMEOUT_MS,
      rateNote: FREE_GOV_RATE_NOTE,
      limitsNote: evidence.reason ?? "FuelEconomy.gov unavailable.",
      facts: [
        {
          key: "evidence.gov_fuel",
          value: {
            status: "unavailable",
            match: evidence.match,
            assumptions: evidence.assumptions,
            scope,
            url: evidence.sourceUrl,
            fetchedAt,
          },
          kind: "unknown",
          source: "gov",
          note: evidence.honesty,
        },
      ],
      summary: "FuelEconomy.gov unavailable — fuel cost not invented.",
      outcomeOk: false,
      outcomeStatus: "failed",
      outcomeCapability: "failed",
      fuelEvidence: evidence,
    };
  }

  if (evidence.match === "no_match") {
    return {
      toolId: "evidence.gov_fuel",
      status: "empty",
      cached: false,
      fetchedAt,
      scope,
      url: evidence.sourceUrl,
      timeoutMs: FREE_GOV_TIMEOUT_MS,
      rateNote: FREE_GOV_RATE_NOTE,
      limitsNote: evidence.reason ?? "No FuelEconomy.gov match.",
      facts: [
        {
          key: "evidence.gov_fuel",
          value: {
            status: "empty",
            match: evidence.match,
            assumptions: evidence.assumptions,
            scope,
            url: evidence.sourceUrl,
            fetchedAt,
          },
          kind: "verified",
          source: "gov",
          note: evidence.honesty,
        },
      ],
      summary: "No FuelEconomy.gov match for this year/make/model.",
      outcomeOk: true,
      outcomeStatus: "empty",
      outcomeCapability: "empty",
      fuelEvidence: evidence,
    };
  }

  const costBit =
    evidence.ambiguous &&
    evidence.annualFuelUsdLow != null &&
    evidence.annualFuelUsdHigh != null &&
    evidence.annualFuelUsdLow !== evidence.annualFuelUsdHigh
      ? `est. $${evidence.annualFuelUsdLow}–$${evidence.annualFuelUsdHigh}/yr (ambiguous)`
      : evidence.annualFuelUsdLow != null
        ? `est. $${evidence.annualFuelUsdLow}/yr`
        : "MPG on file; annual $ pending assumptions";

  return {
    toolId: "evidence.gov_fuel",
    status: "ok",
    cached: false,
    fetchedAt,
    scope,
    url: evidence.sourceUrl,
    timeoutMs: FREE_GOV_TIMEOUT_MS,
    rateNote: FREE_GOV_RATE_NOTE,
    limitsNote: evidence.honesty.slice(0, 280),
    facts: [
      {
        key: "evidence.gov_fuel",
        value: {
          status: "ok",
          match: evidence.match,
          ambiguous: evidence.ambiguous,
          annualFuelUsdLow: evidence.annualFuelUsdLow,
          annualFuelUsdHigh: evidence.annualFuelUsdHigh,
          combMpgLow: evidence.combMpgLow,
          combMpgHigh: evidence.combMpgHigh,
          cityMpgLow: evidence.cityMpgLow,
          highwayMpgLow: evidence.highwayMpgLow,
          fuelType: evidence.fuelType,
          configsConsidered: evidence.configsConsidered,
          assumptions: evidence.assumptions,
          humanPageUrl: evidence.humanPageUrl,
          scope,
          url: evidence.sourceUrl,
          fetchedAt,
        },
        kind: "verified",
        source: "gov",
        note: evidence.honesty,
      },
    ],
    summary: `FuelEconomy.gov ${evidence.match}: ${costBit}.`,
    outcomeOk: true,
    outcomeStatus: "success",
    outcomeCapability: "supported_executed",
    fuelEvidence: evidence,
  };
}

/** Type helper for runner tool unions. */
export type FreeGovScoutToolId = FreeGovToolId | ScoutToolId;
