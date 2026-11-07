/**
 * Free public vehicle-data port for Scout — NHTSA / FuelEconomy / vPIC only.
 * Title / NMVTIS / total-loss remain unknown (future paid replaceable boundary).
 * Never fabricates clean title. Never claims VIN-specific unrepaired recall status.
 */
import { TtlCache } from "@/io/cache";
import {
  complaintsFor,
  decodeVin,
  fuelFor,
  recallsFor,
  type GovDeps,
} from "@/io/gov";
import { safetyRatingsFor } from "@/io/nhtsa-safety";
import type { Listing } from "@/domain/types";
import type { EvidenceFact, ScoutToolId } from "./types";

export const FREE_GOV_TIMEOUT_MS = 12_000;
/** Bounded cache for free public endpoints (same order as listing cache). */
export const FREE_GOV_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const FREE_GOV_RATE_NOTE =
  "Free public NHTSA/FuelEconomy/vPIC — no API key; polite sequential calls; 12s timeout; 6h process cache.";

export type FreeGovToolId =
  | "evidence.gov_recalls"
  | "evidence.gov_fuel"
  | "evidence.gov_vpic"
  | "evidence.gov_safety";

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
};

export type ScoutFreeGovPort = {
  run(toolId: FreeGovToolId, listing: Listing): Promise<FreeGovEvidencePacket>;
};

export function isFreeGovToolId(id: string): id is FreeGovToolId {
  return (
    id === "evidence.gov_recalls" ||
    id === "evidence.gov_fuel" ||
    id === "evidence.gov_vpic" ||
    id === "evidence.gov_safety"
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
}): ScoutFreeGovPort {
  const fetchImpl = opts?.fetch ?? fetch;
  const cache = opts?.cache ?? new TtlCache<FreeGovEvidencePacket>(FREE_GOV_CACHE_TTL_MS);
  const now = opts?.now ?? (() => new Date());
  const deps: GovDeps = { fetch: fetchImpl };

  return {
    async run(toolId, listing) {
      const fetchedAt = now().toISOString();
      const cacheKey = `${toolId}:${listing.vin}:${listing.year}:${listing.make}:${listing.model}`.toLowerCase();
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
        } else if (toolId === "evidence.gov_fuel") {
          packet = await runFuel(listing, deps, fetchedAt);
        } else if (toolId === "evidence.gov_vpic") {
          packet = await runVpic(listing, deps, fetchedAt);
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
              value: { status: "error" },
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
    "nhtsa_recalls+complaints_by_make_model_year — campaigns for the vehicle configuration; NOT VIN-specific unrepaired/open status; NOT title/NMVTIS";
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
          value: { recallsAvailable: false, complaintsAvailable: false },
          kind: "unknown",
          note: "NHTSA recalls/complaints unavailable — not a successful empty result; title/NMVTIS remain unknown.",
        }),
      ],
      summary: "NHTSA recalls/complaints unavailable (not empty-no-record).",
      outcomeOk: false,
      outcomeStatus: "failed",
      outcomeCapability: "failed",
    };
  }

  const parkIt = recalls.records.some((r) => r.parkIt || r.parkOutSide);
  const empty = recalls.available && recalls.records.length === 0;
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
        titleNmvtis: "unknown_not_connected",
      },
      kind: "verified",
      source: "gov",
      note: empty
        ? "NHTSA returned zero make/model/year campaigns (available empty). Not VIN unrepaired status. Title/NMVTIS unknown."
        : parkIt
          ? "NHTSA make/model/year campaigns include park-it/park-outside flags — configuration-level, not VIN repair proof. Title/NMVTIS unknown."
          : "NHTSA make/model/year campaigns recorded. Not VIN-specific unrepaired status. Title/NMVTIS unknown.",
    },
  ];
  if (parkIt) {
    facts.push({
      key: "nhtsa_park_it",
      value: { parkIt: true, scope },
      kind: "verified",
      source: "gov",
      note: "NHTSA park-it/park-outside campaign flag present for make/model/year — adverse safety signal for investigation; not a title brand.",
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
    limitsNote: "Max 8 campaign summaries retained for planner briefs.",
    facts,
    summary: empty
      ? `NHTSA recalls empty for ${listing.year} ${listing.make} ${listing.model} (available).`
      : `NHTSA recalls ${recalls.records.length} campaign(s); complaints=${complaints.available ? complaints.count : "unavailable"}; parkIt=${parkIt}.`,
    outcomeOk: true,
    outcomeStatus: empty ? "empty" : "success",
    outcomeCapability: empty ? "empty" : "supported_executed",
  };
}

async function runFuel(listing: Listing, deps: GovDeps, fetchedAt: string): Promise<FreeGovEvidencePacket> {
  const params = new URLSearchParams({
    year: String(listing.year),
    make: listing.make,
    model: listing.model,
  });
  const url = `https://www.fueleconomy.gov/ws/rest/vehicle/menu/options?${params.toString()}`;
  const scope = "fueleconomy.gov menu/options by year/make/model — EPA config estimate, not VIN-specific";
  const fuel = await fuelFor(listing.year, listing.make, listing.model, listing.engine, deps);
  if (!fuel) {
    return {
      toolId: "evidence.gov_fuel",
      status: "unavailable",
      cached: false,
      fetchedAt,
      scope,
      url,
      timeoutMs: FREE_GOV_TIMEOUT_MS,
      rateNote: FREE_GOV_RATE_NOTE,
      limitsNote: "Menu miss or upstream failure — unavailable (not a fabricated MPG).",
      facts: [
        {
          key: "evidence.gov_fuel",
          value: { status: "unavailable", scope, url, fetchedAt },
          kind: "unknown",
          source: "gov",
          note: "FuelEconomy.gov lookup unavailable — MPG unknown.",
        },
      ],
      summary: "FuelEconomy.gov unavailable for this year/make/model.",
      outcomeOk: false,
      outcomeStatus: "failed",
      outcomeCapability: "failed",
    };
  }
  return {
    toolId: "evidence.gov_fuel",
    status: "ok",
    cached: false,
    fetchedAt,
    scope,
    url,
    timeoutMs: FREE_GOV_TIMEOUT_MS,
    rateNote: FREE_GOV_RATE_NOTE,
    limitsNote: "Up to 6 EPA configs considered.",
    facts: [
      {
        key: "evidence.gov_fuel",
        value: { ...fuel, scope, url, fetchedAt, cached: false, timeoutMs: FREE_GOV_TIMEOUT_MS },
        kind: "verified",
        source: "gov",
        note: `EPA fuel fact (${fuel.match}) — estimate for configuration, not VIN odometer proof.`,
      },
    ],
    summary: `FuelEconomy.gov ${fuel.match}: combMpg=${fuel.combMpg ?? "n/a"} configs=${fuel.configsConsidered}.`,
    outcomeOk: true,
    outcomeStatus: "success",
    outcomeCapability: "supported_executed",
  };
}

async function runVpic(listing: Listing, deps: GovDeps, fetchedAt: string): Promise<FreeGovEvidencePacket> {
  const url = `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(listing.vin)}?format=json`;
  const scope = "nhtsa_vpic_DecodeVinValues — VIN decode specs only; not title/NMVTIS/total-loss/history";
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
  const errorCode = decoded.errorCode ?? "";
  const empty = errorCode !== "" && errorCode !== "0";
  return {
    toolId: "evidence.gov_vpic",
    status: empty ? "empty" : "ok",
    cached: false,
    fetchedAt,
    scope,
    url,
    timeoutMs: FREE_GOV_TIMEOUT_MS,
    rateNote: FREE_GOV_RATE_NOTE,
    limitsNote: "Specs only — never invents title brands or accident history.",
    facts: [
      {
        key: "evidence.gov_vpic",
        value: {
          year: decoded.year,
          make: decoded.make,
          model: decoded.model,
          errorCode: decoded.errorCode,
          scope,
          url,
          fetchedAt,
          titleNmvtis: "unknown_not_connected",
        },
        kind: empty ? "unknown" : "verified",
        source: "gov",
        note: empty
          ? `vPIC returned errorCode=${errorCode} — decode incomplete; title/NMVTIS unknown.`
          : "vPIC VIN decode specs recorded. Title/NMVTIS/total-loss remain unknown_not_connected.",
      },
    ],
    summary: empty
      ? `vPIC decode incomplete (errorCode=${errorCode}).`
      : `vPIC decode ${decoded.year ?? "?"} ${decoded.make ?? "?"} ${decoded.model ?? "?"}.`,
    outcomeOk: !empty,
    outcomeStatus: empty ? "empty" : "success",
    outcomeCapability: empty ? "empty" : "supported_executed",
  };
}

async function runSafety(listing: Listing, deps: GovDeps, fetchedAt: string): Promise<FreeGovEvidencePacket> {
  const scope =
    "nhtsa_safety_ratings_by_make_model_year — configuration crash ratings; not VIN-specific; not title/NMVTIS";
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
          value: { status: "unavailable", scope, url: lookup.indexUrl, fetchedAt },
          kind: "unknown",
          source: "gov",
          note: "NHTSA safety ratings unavailable for this make/model/year.",
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
          value: { status: "empty", scope, url: lookup.indexUrl, fetchedAt, variantCount: 0 },
          kind: "verified",
          source: "gov",
          note: "NHTSA safety ratings index empty for make/model/year (available).",
        },
      ],
      summary: "NHTSA safety ratings empty (available).",
      outcomeOk: true,
      outcomeStatus: "empty",
      outcomeCapability: "empty",
    };
  }
  return {
    toolId: "evidence.gov_safety",
    status: "ok",
    cached: false,
    fetchedAt,
    scope,
    url: lookup.detailUrl ?? lookup.indexUrl,
    timeoutMs: FREE_GOV_TIMEOUT_MS,
    rateNote: FREE_GOV_RATE_NOTE,
    limitsNote: "Up to 3 VehicleId detail rows fetched.",
    facts: [
      {
        key: "evidence.gov_safety",
        value: {
          status: "ok",
          scope,
          url: lookup.detailUrl ?? lookup.indexUrl,
          indexUrl: lookup.indexUrl,
          fetchedAt,
          variants: lookup.variants,
        },
        kind: "verified",
        source: "gov",
        note: "NHTSA configuration safety ratings recorded — not VIN-specific crash history; title/NMVTIS unknown.",
      },
    ],
    summary: `NHTSA safety ratings: ${lookup.variants.length} variant(s); overall=${lookup.variants[0]?.overallRating ?? "n/a"}.`,
    outcomeOk: true,
    outcomeStatus: "success",
    outcomeCapability: "supported_executed",
  };
}

/** Type helper for runner tool unions. */
export type FreeGovScoutToolId = FreeGovToolId | ScoutToolId;
