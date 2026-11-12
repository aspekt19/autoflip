/**
 * Consumer /find match orchestration — testable without the Next route shell.
 * Server-owned provider query budget; first query error does not abort remaining directions.
 */
import { coverageConfidence, coverageSentence } from "@/domain/coverage";
import { proposeDirections, type SearchDirection } from "@/domain/directions";
import {
  emptyReasonFromProviderError,
  findEmptyCopy,
  resolveFindEmptyFromOutcomes,
  statusForFindEmpty,
  type FindEmptyReason,
  type FindQueryOutcomeKind,
} from "@/domain/find-empty";
import { admitFindListingForBudget, assessFindListingPrice, type FindListingPriceView } from "@/domain/find-listing-price";
import { diversifyListingsByModel } from "@/domain/find-model-observe";
import { rankFlipCandidates } from "@/domain/flip-rank";
import {
  listingWithinNeed,
  needPrefersAwd,
  noMatchMessage,
  searchScopeLabel,
  validateNeed,
  type StructuredNeed,
} from "@/domain/need";
import { isPassengerOrLightTruck } from "@/domain/passenger-vehicle";
import { awdLimitFromText } from "@/domain/note-intake";
import { implausibleOdometer } from "@/domain/find-best-deal";
import { FIND_INVENTORY_QUERY_MS, FIND_INVENTORY_STAGE_MS } from "@/domain/route-budget";
import { broadenOpenDirections, openRetryModels, towingCapacityCaveat } from "@/domain/open-search";
import { broadenStarterDirections, isOpenStarterNote, starterRetryModels } from "@/domain/starter-search";
import { filterInventoryWithWiden } from "@/domain/inventory-widen";
import { buildSearchSpec, enforceHard, hardDropSentence } from "@/domain/search-spec";
import { decodeVin } from "@/io/gov";
import { priceCompsUnevenAcrossListings, selectBestDealOnEvidence } from "@/domain/find-best-deal";
import { priceBadge, type PriceBadge } from "@/domain/price-badge";
import { reconUsd } from "@/domain/recon";
import type { Listing } from "@/domain/types";
import { geoScopeFromSearch, rememberComps, type CompGeoScope } from "@/io/comp-cache";
import type { Kv } from "@/io/kv";
import { getOrComputeValuation } from "@/io/vin-day-valuation-store";
import { assembleRadar, type AssembleDeps } from "@/server/assemble";
import {
  isServerlessRuntime,
  requireSharedQuotaForPaidDispatch,
} from "@/server/paid-dispatch-guard";

/** Hard ceiling on Autodev searches per /find request — not client-raisable. */
export const FIND_MAX_PROVIDER_QUERIES = 6;

/** Interim personal ranking until PR B triage — never leave sort key at 0. */
function personalRankScores(
  listings: readonly Listing[],
  need: StructuredNeed,
): Map<string, number> {
  if (listings.length === 0) return new Map();
  const deal = selectBestDealOnEvidence({
    need: {
      budgetKnown: need.budgetKnown,
      budgetUsd: need.budgetUsd,
      preferredModels: need.preferredModels,
      conditionPriority: need.conditionPriority,
      note: need.note,
      awdPreference: need.awdPreference,
      mustHaves: need.mustHaves,
    },
    listings: listings.map((row) => ({
      key: (row.vin || `${row.year}-${row.make}-${row.model}-${row.priceUsd}`).toUpperCase(),
      year: row.year,
      make: row.make,
      model: row.model,
      priceUsd: row.priceUsd,
      miles: row.miles,
      vin: row.vin,
      drivetrain: row.drivetrain,
      fuel: row.fuel,
      bodyStyle: row.bodyStyle,
      style: row.style,
      engine: row.engine,
    })),
  });
  const out = new Map<string, number>();
  for (const row of deal.allRanked) {
    const vin = (row.vin || row.key || "").trim().toUpperCase();
    if (vin) out.set(vin, row.score);
  }
  return out;
}

export type FindMatchDeps = AssembleDeps & {
  kv: Kv;
  env?: Record<string, string | undefined>;
  /** Override server query ceiling in tests. */
  maxProviderQueries?: number;
  /**
   * When true, dispatch Auto.dev queries concurrently (Resale path).
   * Find stays sequential by default to preserve existing pacing.
   */
  parallelProviderQueries?: boolean;
  /** Wall-clock stage cap for the inventory wave (ms). */
  inventoryStageCapMs?: number;
  /** Shared deadline — stop dispatching when expired. */
  deadline?: { remainingMs: () => number; expired: () => boolean; allow: (needMs: number) => boolean };
  /** Test seam — production uses assembleRadar. */
  assembleRadarImpl?: typeof assembleRadar;
};

export type FindMatchListing = Listing & {
  overBudget?: boolean;
  badge: PriceBadge;
  flipNote: string | null;
  clearsTarget: boolean | null;
  priceView: FindListingPriceView;
  drivetrainUnverified?: boolean;
};

export type FindMatchGroup = {
  direction: SearchDirection;
  listings: FindMatchListing[];
  coverage: string;
  coverageLevel: "low" | "medium" | "high";
  note: string | null;
  /** Full planned query list for this direction (may include budget-skipped). */
  plannedModels: Array<{ make: string; model: string }>;
  /**
   * Models with a successful provider response (ok or confirmed empty).
   * UI "Live models checked" must use this — never timeouts/failures.
   */
  searchedModels: Array<{ make: string; model: string }>;
  /** Dispatched but failed/timed out/unsupported — attempted, not successfully checked. */
  failedModels: Array<{ make: string; model: string; outcome: FindQueryOutcomeKind }>;
  /** Planned but never dispatched because the server query ceiling was hit. */
  skippedModels: Array<{ make: string; model: string; reason: "budget_exhausted" }>;
  providerWarning: string | null;
  queryOutcomes: Array<{
    make: string;
    model: string;
    outcome: FindQueryOutcomeKind;
    message: string | null;
  }>;
};

export type FindMatchResult =
  | {
      ok: true;
      status: number;
      body: {
        ok: true;
        sample: false;
        emptyReason: FindEmptyReason | null;
        message: string | null;
        headline: string | null;
        nextStep: string | null;
        scope: string;
        affordabilityAssessed: boolean;
        partialFailure: boolean;
        geoScope: CompGeoScope;
        directions: FindMatchGroup[];
        /**
         * Full provider-returned listings for this search (pre–diversify-to-8),
         * used for market comps / badges so same-model peers are not limited to
         * the 24 shown cards. Shown cards remain in `directions`.
         */
        compsPool: Listing[];
        providerQueriesUsed: number;
      };
    }
  | {
      ok: false;
      status: number;
      body: Record<string, unknown>;
    };

function queriesForDirection(
  direction: SearchDirection,
): Array<{ make: string; model: string; bodyStyle?: string }> {
  // Search every planned model on the direction (named or editorial). The match
  // planner still caps at FIND_MAX_PROVIDER_QUERIES — never explode past that.
  const seen = new Set<string>();
  const out: Array<{ make: string; model: string; bodyStyle?: string }> = [];
  for (const m of direction.models) {
    if (!m.make?.trim() && !m.model?.trim()) continue;
    const key = `${m.make}\0${m.model}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  if (out.length === 0 && direction.search?.make?.trim()) out.push(direction.search);
  // Body-style-only direction (models emptied by validateFindPlan) — one inventory query.
  if (out.length === 0 && direction.bodyStyle) {
    out.push({ make: "", model: "", bodyStyle: direction.bodyStyle });
  }
  return out;
}

function confirmedYears(
  direction: SearchDirection,
  need: StructuredNeed,
  refine?: { yearMin?: number; yearMax?: number },
): { yearMin?: number; yearMax?: number } {
  return {
    yearMin: refine?.yearMin ?? need.yearMin ?? direction.yearMin,
    yearMax: refine?.yearMax ?? need.yearMax ?? direction.yearMax,
  };
}

/** A named compact is not searched as an SUV. An open or comma-joined style is left off the request. */
function bodyStyleForQuery(model: string, body?: string | null): string | undefined {
  const named = body?.trim();
  if (!named || /^any$/i.test(named) || named.includes(",")) return undefined;
  if (/corolla|civic|camry|accord|mazda3|elantra|sentra|jetta|impreza/i.test(model) && /suv|truck|van|minivan/i.test(named)) {
    return undefined;
  }
  return named;
}

function budgetOnlyDirection(need: StructuredNeed): SearchDirection {
  const year = new Date().getUTCFullYear();
  return {
    id: "budget-only",
    segment: "Your budget",
    why: "No model was named, so this search uses your budget and hard limits only.",
    guidance: "editorial",
    yearMin: need.yearMin ?? year,
    yearMax: need.yearMax ?? year + 1,
    yearBecause: "Budget-only search.",
    models: [],
    search: { make: "", model: "" },
  };
}

/** Hard all-wheel drive: confirm a blank drivetrain from the VIN decode, or mark it unverified. */
async function fillHardDrivetrain(listings: Listing[], need: StructuredNeed, fetchImpl?: typeof fetch): Promise<Listing[]> {
  if (need.mode === "flip" || awdLimitFromText(need.note ?? "") !== "hard") return listings;
  const out: Listing[] = [];
  let decoded = 0;
  for (const listing of listings) {
    if (listing.drivetrain?.trim()) {
      out.push(listing);
      continue;
    }
    if (!fetchImpl || decoded >= 8 || listing.vin.length !== 17) {
      out.push({ ...listing, drivetrainUnverified: true });
      continue;
    }
    decoded += 1;
    const row = await decodeVin(listing.vin, { fetch: fetchImpl }).catch(() => null);
    const drive = row?.driveType?.trim();
    if (drive) out.push({ ...listing, drivetrain: drive });
    else out.push({ ...listing, drivetrainUnverified: true });
  }
  return out;
}

function applyHardGate(collected: Listing[], need: StructuredNeed): { listings: Listing[]; note: string | null } {
  const cars = need.mode === "flip" ? collected : collected.filter((row) => isPassengerOrLightTruck(row));
  const hiddenOther = collected.length - cars.length;
  const spec = buildSearchSpec({
    note: need.note ?? "",
    mode: need.mode,
    formEdits: {
      priceMaxUsd:
        need.budgetKnown && need.budgetUsd != null ? { value: need.budgetUsd, dirty: true } : undefined,
      yearMin: need.yearMin != null ? { value: need.yearMin, dirty: true } : undefined,
      yearMax: need.yearMax != null ? { value: need.yearMax, dirty: true } : undefined,
      milesMax: need.milesMax != null ? { value: need.milesMax, dirty: true } : undefined,
      radiusMi: { value: need.distanceMiles, dirty: true },
    },
  });
  const gated = enforceHard(spec, cars);
  const otherNote =
    hiddenOther > 0
      ? `${hiddenOther} motorcycle${hiddenOther === 1 ? "" : "s"}, RV${hiddenOther === 1 ? "" : "s"}, or other non-car${hiddenOther === 1 ? "" : "s"} ${hiddenOther === 1 ? "was" : "were"} left out.`
      : null;
  if (need.mode !== "flip") {
    return { listings: gated.kept, note: [hardDropSentence(gated.dropped), otherNote].filter(Boolean).join(" ") || null };
  }
  // Flip ranking needs the wider asking-price set as comps. Price-only misses stay
  // in that pool; the ranker excludes anomalies and does not treat a gap as profit.
  const blocked = new Set(gated.dropped.filter((row) => row.rule !== "price").map((row) => row.vin));
  return {
    listings: collected.filter((car) => !blocked.has(car.vin)),
    note: hardDropSentence(gated.dropped.filter((row) => row.rule !== "price")),
  };
}

function withinBudget(
  listings: Listing[],
  budgetUsd: number | null,
  known: boolean,
): Array<Listing & { overBudget?: boolean; priceView: FindListingPriceView }> {
  return listings.flatMap((item) => {
    const admission = admitFindListingForBudget(item, budgetUsd, known);
    if (!admission.admit) return [];
    return [{ ...item, overBudget: admission.overBudget, priceView: admission.price }];
  });
}

/** Deduplicate shopper-facing warning strings without dropping distinct failures. */
export function dedupeWarningMessages(messages: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of messages) {
    const text = (raw ?? "").trim();
    if (!text) continue;
    const key = text.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    // Drop a shorter warning that is already contained in a longer one.
    let contained = false;
    for (const existing of out) {
      if (existing.toLowerCase().includes(key)) {
        contained = true;
        break;
      }
    }
    if (contained) continue;
    // Replace longer entries that the new text supersedes.
    for (let i = out.length - 1; i >= 0; i -= 1) {
      if (key.includes(out[i]!.toLowerCase()) && key !== out[i]!.toLowerCase()) {
        seen.delete(out[i]!.toLowerCase().replace(/\s+/g, " "));
        out.splice(i, 1);
      }
    }
    seen.add(key);
    out.push(text);
  }
  return out;
}

export async function runFindMatch(
  body: {
    need?: unknown;
    refine?: { make?: string; model?: string; yearMin?: number; yearMax?: number };
    /** When set (e.g. Resale multi-direction plan), skip proposeDirections collapse. */
    directions?: SearchDirection[];
  } | null,
  deps: FindMatchDeps,
): Promise<FindMatchResult> {
  const parsed = validateNeed(body?.need);
  if (!parsed.ok) {
    const empty = findEmptyCopy("invalid_need", null, parsed.issues[0]?.message ?? "That need is not usable.");
    return {
      ok: false,
      status: statusForFindEmpty(empty.reason),
      body: {
        error: "invalid_need",
        emptyReason: empty.reason,
        message: empty.detail,
        headline: empty.headline,
        nextStep: empty.nextStep,
      },
    };
  }

  const need = parsed.need;
  let directions = broadenOpenDirections(
    need.note,
    broadenStarterDirections(
      need.note,
      body?.directions && body.directions.length > 0 ? body.directions : proposeDirections(need, body?.refine),
    ),
    need.bodyStyle,
  );
  if (directions.length === 0) directions = [budgetOnlyDirection(need)];
  if (directions.length === 0) {
    const empty = findEmptyCopy("no_directions", need);
    return {
      ok: true,
      status: 200,
      body: {
        ok: true,
        sample: false,
        emptyReason: empty.reason,
        message: empty.detail,
        headline: empty.headline,
        nextStep: empty.nextStep,
        scope: searchScopeLabel(need),
        affordabilityAssessed: need.budgetKnown,
        partialFailure: false,
        geoScope: geoScopeFromSearch({ searchZip: need.zip, distanceMiles: need.distanceMiles }),
        directions: [],
        compsPool: [],
        providerQueriesUsed: 0,
      },
    };
  }

  // Shared-store gate BEFORE any Autodev upstream on serverless.
  // Truthful reason: missing shared store — NOT a missing Auto.dev key.
  const serverless = isServerlessRuntime(deps.env ?? process.env);
  const storeGate = requireSharedQuotaForPaidDispatch({ kv: deps.kv, serverless });
  if (!storeGate.ok) {
    const empty = findEmptyCopy("shared_store_required", need, storeGate.message);
    return {
      ok: false,
      status: statusForFindEmpty(empty.reason),
      body: {
        error: storeGate.error,
        emptyReason: empty.reason,
        message: empty.detail,
        headline: empty.headline,
        nextStep: empty.nextStep,
        scope: searchScopeLabel(need),
      },
    };
  }

  const maxQueries = Math.max(1, Math.min(FIND_MAX_PROVIDER_QUERIES, deps.maxProviderQueries ?? FIND_MAX_PROVIDER_QUERIES));
  const radiusMiles = need.distanceMiles;
  // ZIP alone (no radius) still goes to the provider so results can sort by distance —
  // geo scope stays nationwide until an explicit radius is set.
  const searchZip = need.zip?.replace(/\D/g, "").slice(0, 5) || undefined;
  const geoScope = geoScopeFromSearch({
    searchZip: radiusMiles != null ? searchZip : null,
    distanceMiles: radiusMiles,
  });

  const groups: FindMatchGroup[] = [];
  let message: string | null = null;
  let partialFailureWarning: string | null = null;
  let providerQueriesUsed = 0;
  /** Cross-direction VIN dedupe — same listing must not repeat under a second segment. */
  const seenVins = new Set<string>();
  /**
   * Pre-diversify pool for market comps/badges — every priced listing the provider
   * returned that still fits the need/budget, not only the 8-per-group shown cards.
   */
  const compsPoolAcc: Listing[] = [];
  const compsPoolVins = new Set<string>();

  type PlannedQuery = {
    direction: SearchDirection;
    query: { make: string; model: string; bodyStyle?: string };
    directionIndex: number;
  };
  const planned: PlannedQuery[] = [];
  const skippedByDirection = new Map<number, Array<{ make: string; model: string; reason: "budget_exhausted" }>>();
  for (let di = 0; di < directions.length; di++) {
    const direction = directions[di]!;
    for (const query of queriesForDirection(direction)) {
      if (planned.length >= maxQueries) {
        const list = skippedByDirection.get(di) ?? [];
        list.push({ make: query.make, model: query.model, reason: "budget_exhausted" });
        skippedByDirection.set(di, list);
        continue;
      }
      if (deps.deadline?.expired()) {
        const list = skippedByDirection.get(di) ?? [];
        list.push({ make: query.make, model: query.model, reason: "budget_exhausted" });
        skippedByDirection.set(di, list);
        continue;
      }
      planned.push({ direction, query, directionIndex: di });
    }
  }
  if (planned.length === 0) {
    const direction = directions[0] ?? budgetOnlyDirection(need);
    planned.push({ direction, query: { make: "", model: "", bodyStyle: direction.bodyStyle }, directionIndex: 0 });
  }

  type DispatchRow = {
    planned: PlannedQuery;
    result: Awaited<ReturnType<typeof assembleRadar>> | null;
    timedOut: boolean;
  };

  const runAssemble = deps.assembleRadarImpl ?? assembleRadar;

  async function dispatchOne(job: PlannedQuery): Promise<DispatchRow> {
    try {
      const result = await runAssemble(
        {
          make: job.query.make,
          model: job.query.model,
          bodyStyle: bodyStyleForQuery(job.query.model, job.query.bodyStyle ?? job.direction.bodyStyle),
          zip: searchZip,
          ...confirmedYears(job.direction, need, body?.refine),
          distanceMiles: radiusMiles,
          mode: need.mode,
          milesMax: need.milesMax ?? undefined,
          priceMax: need.budgetKnown && need.budgetUsd ? need.budgetUsd : undefined,
          skipRadarGuard: true,
        },
        deps,
      );
      return { planned: job, result, timedOut: false };
    } catch {
      return { planned: job, result: null, timedOut: true };
    }
  }

  let dispatches: DispatchRow[] = [];
  const stageCap = deps.inventoryStageCapMs ?? FIND_INVENTORY_STAGE_MS;
  const remaining = deps.deadline ? deps.deadline.remainingMs() : stageCap;
  const inventoryCapMs = Math.max(1, Math.min(stageCap, remaining));
  const queryWaitMs = Math.min(FIND_INVENTORY_QUERY_MS, inventoryCapMs);
  // PR A: search all planned models in parallel within the inventory stage budget.
  const useParallel = deps.parallelProviderQueries !== false && planned.length > 0;
  if (useParallel) {
    // Shared stage AbortController: when the inventory cap fires, abort in-flight
    // Auto.dev fetches so nothing keeps the isolate alive after we return.
    const stageAbort = new AbortController();
    const stageTimer = setTimeout(() => stageAbort.abort(), inventoryCapMs);
    const cappedDeps: FindMatchDeps = {
      ...deps,
      autodev: deps.autodev
        ? {
            ...deps.autodev,
            signal: stageAbort.signal,
            // Each query has its own wait. The stage cap only stops stragglers
            // so a slow model cannot use the whole route.
            timeoutMs: deps.autodev.timeoutMs ?? queryWaitMs,
          }
        : deps.autodev,
    };
    const runCapped = deps.assembleRadarImpl ?? assembleRadar;
    async function dispatchCapped(job: PlannedQuery): Promise<DispatchRow> {
      if (stageAbort.signal.aborted) {
        return { planned: job, result: null, timedOut: true };
      }
      try {
        const result = await runCapped(
          {
            make: job.query.make,
            model: job.query.model,
            bodyStyle: bodyStyleForQuery(job.query.model, job.query.bodyStyle ?? job.direction.bodyStyle),
            zip: searchZip,
            ...confirmedYears(job.direction, need, body?.refine),
            distanceMiles: radiusMiles,
            mode: need.mode,
            milesMax: need.milesMax ?? undefined,
            priceMax: need.budgetKnown && need.budgetUsd ? need.budgetUsd : undefined,
            skipRadarGuard: true,
          },
          cappedDeps,
        );
        return { planned: job, result, timedOut: stageAbort.signal.aborted };
      } catch {
        return { planned: job, result: null, timedOut: true };
      }
    }
    try {
      dispatches = await Promise.all(planned.map((job) => dispatchCapped(job)));
      providerQueriesUsed = planned.length;
    } finally {
      clearTimeout(stageTimer);
      if (!stageAbort.signal.aborted) stageAbort.abort();
    }
  } else {
    for (const job of planned) {
      if (deps.deadline?.expired()) {
        dispatches.push({ planned: job, result: null, timedOut: true });
        continue;
      }
      dispatches.push(await dispatchOne(job));
      providerQueriesUsed += 1;
    }
  }

  if (isOpenStarterNote(need.note)) {
    const returned = dispatches.flatMap((row) => (row.result?.ok ? row.result.listings : []));
    const anyFit = returned.some((row) => {
      if (!isPassengerOrLightTruck(row)) return false;
      if (need.budgetKnown && need.budgetUsd != null && row.priceUsd != null && row.priceUsd > need.budgetUsd) return false;
      if (need.milesMax != null && row.miles != null && row.miles > need.milesMax) return false;
      if (need.yearMin != null && row.year < need.yearMin) return false;
      if (need.distanceMiles != null && row.distanceMiles != null && row.distanceMiles > need.distanceMiles) return false;
      return true;
    });
    const compactBack = /corolla|civic|camry|accord|mazda3|elantra|sentra|jetta|impreza/i;
    const fitting = returned.filter((row) => {
      if (!isPassengerOrLightTruck(row)) return false;
      if (need.budgetKnown && need.budgetUsd != null && row.priceUsd != null && row.priceUsd > need.budgetUsd) return false;
      if (need.milesMax != null && row.miles != null && row.miles > need.milesMax) return false;
      if (need.yearMin != null && row.year < need.yearMin) return false;
      if (need.distanceMiles != null && row.distanceMiles != null && row.distanceMiles > need.distanceMiles) return false;
      return true;
    });
    const needsCompact = !fitting.some((row) => compactBack.test(`${row.make} ${row.model}`));
    if (!anyFit || needsCompact) {
      const already = new Set(
        dispatches.map((row) => `${row.planned.query.make}\0${row.planned.query.model}`.toLowerCase()),
      );
      const emptyFirst = dispatches.flatMap((row) => {
        const model = row.planned.query.model;
        if (!compactBack.test(model)) return [];
        const listings = row.result?.ok ? row.result.listings : [];
        if (!row.timedOut && listings.length > 0) return [];
        return [{ make: row.planned.query.make, model }];
      });
      const retryModels = [...emptyFirst, ...starterRetryModels(already)];
      const retryJobs = retryModels.map((query) => ({
        direction: { ...(directions[0] ?? budgetOnlyDirection(need)), bodyStyle: undefined },
        query,
        directionIndex: 0,
      }));
      if (retryJobs.length > 0) {
        const more = await Promise.all(retryJobs.map((job) => dispatchOne(job)));
        dispatches = [...dispatches, ...more];
        providerQueriesUsed += more.length;
      }
    }
  }

  // A first wave that fits nothing runs the rest of the open list (hybrid preference
  // or an unnamed truck). A model the shopper named is not replaced.
  {
    const returned = dispatches.flatMap((row) => (row.result?.ok ? row.result.listings : []));
    const anyFit = returned.some((row) => {
      if (!isPassengerOrLightTruck(row)) return false;
      if (need.budgetKnown && need.budgetUsd != null && row.priceUsd != null && row.priceUsd > need.budgetUsd) return false;
      if (need.milesMax != null && row.miles != null && row.miles > need.milesMax) return false;
      if (need.yearMin != null && row.year < need.yearMin) return false;
      return true;
    });
    if (!anyFit) {
      const already = new Set(
        dispatches.map((row) => `${row.planned.query.make}\0${row.planned.query.model}`.toLowerCase()),
      );
      const retryModels = openRetryModels(need.note, already, need.bodyStyle);
      if (retryModels.length > 0) {
        const retryJobs = retryModels.map((query) => ({
          direction: { ...(directions[0] ?? budgetOnlyDirection(need)), bodyStyle: undefined },
          query,
          directionIndex: 0,
        }));
        const more = await Promise.all(retryJobs.map((job) => dispatchOne(job)));
        dispatches = [...dispatches, ...more];
        providerQueriesUsed += more.length;
      }
    }
  }

  // Soft preferences that emptied local inventory are loosened in filterInventoryWithWiden.
  // An explicit radius is never auto-widened to Nationwide (Chicago live defect).
  const nationwideWidenNote: string | null = null;
  const filterNeed = need;

  // Group dispatch results by direction index for the existing post-processing.
  const byDirection = new Map<number, DispatchRow[]>();
  for (const row of dispatches) {
    const list = byDirection.get(row.planned.directionIndex) ?? [];
    list.push(row);
    byDirection.set(row.planned.directionIndex, list);
  }

  for (let di = 0; di < directions.length; di++) {
    const direction = directions[di]!;
    const collected: Listing[] = [];
    let directionNote: string | null = null;
    let directionWarning: string | null = null;
    const queryOutcomes: FindMatchGroup["queryOutcomes"] = [];
    const rows = byDirection.get(di) ?? [];

    for (const skip of skippedByDirection.get(di) ?? []) {
      queryOutcomes.push({
        make: skip.make,
        model: skip.model,
        outcome: "budget_exhausted",
        message: "Server provider query budget exhausted for this /find request.",
      });
      directionWarning = "Server provider query budget reached — remaining models were not searched.";
      partialFailureWarning = directionWarning;
    }

    for (const row of rows) {
      const query = row.planned.query;
      if (row.timedOut || !row.result) {
        queryOutcomes.push({
          make: query.make,
          model: query.model,
          outcome: "timeout",
          message: "Inventory lookup hit the stage time budget.",
        });
        directionWarning = "Inventory lookup hit the stage time budget — some models were not searched.";
        partialFailureWarning = directionWarning;
        continue;
      }
      const result = row.result;

      if (!result.ok) {
        const reason = emptyReasonFromProviderError(
          result.error === "listings_error" && /did not respond|timed? ?out/i.test(result.message)
            ? "provider_timeout"
            : result.error,
        );
        const outcome: FindQueryOutcomeKind =
          reason === "provider_timeout"
            ? "timeout"
            : reason === "listings_unconfigured" || reason === "shared_store_required"
              ? "unsupported"
              : reason === "demo_limit"
                ? "demo_limit"
                : "error";
        queryOutcomes.push({
          make: query.make,
          model: query.model,
          outcome,
          message: result.message,
        });
        directionWarning = findEmptyCopy(reason, need, result.message).detail;
        partialFailureWarning = directionWarning;
        // Continue to next model / direction — do not abort the whole match.
        continue;
      }

      if (result.sample || result.listings.some((item) => item.source === "sample")) {
        const empty = findEmptyCopy(
          "listings_unconfigured",
          need,
          "A sample fixture was returned where live inventory was required. Those rows were discarded.",
        );
        return {
          ok: false,
          status: statusForFindEmpty(empty.reason),
          body: {
            error: "sample_rejected",
            emptyReason: empty.reason,
            message: empty.detail,
            headline: empty.headline,
            nextStep: empty.nextStep,
            scope: searchScopeLabel(need),
          },
        };
      }

      if (result.listings.length === 0) {
        queryOutcomes.push({
          make: query.make,
          model: query.model,
          outcome: "empty",
          message: result.message,
        });
      } else {
        queryOutcomes.push({
          make: query.make,
          model: query.model,
          outcome: "ok",
          message: null,
        });
      }

      collected.push(...result.listings);
      directionNote = result.message;
      // Key by ACTUAL search geography — never write nationwide rows under desired need.zip.
      await rememberComps(
        deps.kv,
        { make: query.make, model: query.model, geo: geoScope },
        result.listings,
      ).catch(() => undefined);
    }

    // Flip mode keeps code P&L scores for hard guardrails (negative resale profit).
    // Personal Find does not invent a score-0 ranking — SERV settles the pick later.
    const ranked =
      need.mode === "flip"
        ? rankFlipCandidates(collected, new Date(), {
            repairAbility: need.repairAbility,
            targetProfitUsd: need.targetProfitUsd,
          })
        : [];
    const byVin = new Map(ranked.map((item) => [item.vin, item]));
    const assumption =
      need.mode === "flip" ? reconUsd({ miles: null, repairAbility: need.repairAbility }).because : null;
    const prepared = await fillHardDrivetrain(collected, need, deps.fetch);
    let narrowed: Listing[];
    if (need.mode === "flip") {
      const gated = applyHardGate(prepared, need);
      if (gated.note) directionNote = [directionNote, gated.note].filter(Boolean).join(" ");
      narrowed = gated.listings.filter((item) => listingWithinNeed(item, need));
    } else {
      const cars = prepared.filter((row) => isPassengerOrLightTruck(row));
      const hiddenOther = prepared.length - cars.length;
      const widen = filterInventoryWithWiden(cars, filterNeed);
      const otherNote =
        hiddenOther > 0
          ? `${hiddenOther} motorcycle${hiddenOther === 1 ? "" : "s"}, RV${hiddenOther === 1 ? "" : "s"}, or other non-car${hiddenOther === 1 ? "" : "s"} ${hiddenOther === 1 ? "was" : "were"} left out.`
          : null;
      // Nationwide widen note is attached once on the first direction only.
      const onceWiden = di === 0 ? nationwideWidenNote : null;
      const widenNote =
        onceWiden ??
        widen.explanation ??
        (widen.dropped.length && widen.listings.length === 0 ? hardDropSentence(widen.dropped) : null);
      const gateNote = [widenNote, otherNote].filter(Boolean).join(" ") || null;
      if (gateNote) directionNote = [directionNote, gateNote].filter(Boolean).join(" ");
      narrowed = widen.listings;
    }
    const personalScores =
      need.mode === "personal" ? personalRankScores(narrowed, need) : new Map<string, number>();
    const rankedReady = withinBudget(narrowed, need.budgetUsd, need.budgetKnown)
      .map((item) => {
        const priceView = item.priceView ?? assessFindListingPrice(item);
        return {
          ...item,
          priceView,
          // Untrusted asks must not get a fake “good/fair” rating from the fee figure.
          badge: priceView.usableForBudget ? priceBadge(item, collected) : priceBadge({ ...item, priceUsd: null }, collected),
          flipNote: byVin.get(item.vin)?.assumption ?? assumption,
          clearsTarget: byVin.get(item.vin)?.clearsTarget ?? null,
        };
      })
      .sort((a, b) => {
        // Budget hard filter only for personal; flip may order by P&L score for display.
        // Negative resale profit is a settle/pick guardrail (not an inventory wipe).
        const aOver = a.overBudget ? 1 : 0;
        const bOver = b.overBudget ? 1 : 0;
        if (aOver !== bOver) return aOver - bOver;
        if (need.mode === "flip") {
          return (byVin.get(b.vin)?.score ?? 0) - (byVin.get(a.vin)?.score ?? 0);
        }
        // Prefer personalRankScores (newer + lower miles within budget) over ask-price alone.
        const vinA = (a.vin || "").trim().toUpperCase();
        const vinB = (b.vin || "").trim().toUpperCase();
        const scoreA = personalScores.get(vinA);
        const scoreB = personalScores.get(vinB);
        if (scoreA != null || scoreB != null) {
          const sa = scoreA ?? Number.NEGATIVE_INFINITY;
          const sb = scoreB ?? Number.NEGATIVE_INFINITY;
          if (sa !== sb) return sb - sa;
        }
        // Tie-break: newer year, then lower miles, then lower ask, then VIN.
        if (a.year !== b.year) return b.year - a.year;
        const ma = a.miles ?? Number.POSITIVE_INFINITY;
        const mb = b.miles ?? Number.POSITIVE_INFINITY;
        if (ma !== mb) return ma - mb;
        const pa = a.priceUsd ?? Number.POSITIVE_INFINITY;
        const pb = b.priceUsd ?? Number.POSITIVE_INFINITY;
        if (pa !== pb) return pa - pb;
        return (a.vin || "").localeCompare(b.vin || "");
      })
      .filter((item) => {
        // Drop VINs already shown under an earlier direction; only claim shown rows.
        const vin = (item.vin || "").trim().toUpperCase();
        if (!vin) return true;
        if (seenVins.has(vin)) return false;
        return true;
      });
    // Keep full provider returns for comps before diversify shrinks the shown page.
    for (const item of rankedReady) {
      const vin = (item.vin || "").trim().toUpperCase();
      if (vin && compsPoolVins.has(vin)) continue;
      if (vin) compsPoolVins.add(vin);
      compsPoolAcc.push({
        vin: item.vin,
        year: item.year,
        make: item.make,
        model: item.model,
        trim: item.trim,
        priceUsd: item.priceUsd,
        miles: item.miles,
        city: item.city,
        state: item.state,
        zip: item.zip,
        dealer: item.dealer,
        vdp: item.vdp,
        primaryImage: item.primaryImage,
        carfaxUrl: item.carfaxUrl,
        used: item.used,
        cpo: item.cpo,
        accidentCount: item.accidentCount,
        oneOwner: item.oneOwner,
        ownerCount: item.ownerCount,
        usageType: item.usageType,
        fuel: item.fuel,
        engine: item.engine,
        drivetrain: item.drivetrain,
        bodyStyle: item.bodyStyle,
        latitude: item.latitude,
        longitude: item.longitude,
        removedAt: item.removedAt,
        createdAt: item.createdAt,
        source: item.source,
        distanceMiles: item.distanceMiles,
      });
    }
    // Named multi-model searches: do not let the first-queried model fill all 8 slots
    // when other named models also returned inventory (t310 CR-V-only window).
    // Soft AWD preference reorders within each model bucket so FWD cannot bury AWD.
    const believable = rankedReady.filter((item) => !implausibleOdometer(item.year, item.miles));
    const hiddenOdd = rankedReady.length - believable.length;
    if (hiddenOdd > 0) {
      directionNote = [
        directionNote,
        `${hiddenOdd} listing${hiddenOdd === 1 ? " was" : "s were"} hidden because the mileage does not look believable.`,
      ]
        .filter(Boolean)
        .join(" ");
    }
    const listings = diversifyListingsByModel(believable, 8, {
      preferAwd: needPrefersAwd(need),
    });
    for (const item of listings) {
      const vin = (item.vin || "").trim().toUpperCase();
      if (vin) seenVins.add(vin);
    }
    const coverageInput = {
      mode: need.mode,
      sample: false,
      dealerListingCount: listings.length,
      radiusMiles: radiusMiles,
      historyOnListing: false,
    };
    const emptyNote =
      listings.length === 0
        ? // Prefer the single widen/drop sentence already on directionNote — avoid repeating “No cars…”.
          directionNote && /No cars matched|widened|loosened|listings were hidden/i.test(directionNote)
            ? null
            : noMatchMessage(filterNeed, { widenExplanation: di === 0 ? nationwideWidenNote : null })
        : null;
    const succeeded = queryOutcomes.filter((o) => o.outcome === "ok" || o.outcome === "empty");
    const confirmedEmpty = queryOutcomes.filter((o) => o.outcome === "empty");
    const failed = queryOutcomes.filter(
      (o) =>
        o.outcome === "timeout" ||
        o.outcome === "error" ||
        o.outcome === "demo_limit" ||
        o.outcome === "unsupported",
    );
    const skipped = queryOutcomes
      .filter((o) => o.outcome === "budget_exhausted")
      .map((o) => ({ make: o.make, model: o.model, reason: "budget_exhausted" as const }));
    const coverageIncomplete = failed.length > 0;
    const coverageBase = coverageSentence(coverageInput);
    const coverageExtra = coverageIncomplete
      ? `Coverage incomplete: ${failed.map((f) => `${f.make} ${f.model} (${f.outcome})`).join(", ")} did not return a successful provider response — not the same as confirmed empty inventory.`
      : null;
    const emptyModelsNote =
      confirmedEmpty.length > 0
        ? `Confirmed empty this scope (provider returned no rows): ${confirmedEmpty
            .map((o) => `${o.make} ${o.model}`)
            .join(", ")}.`
        : null;
    // Keep provider failure out of `note` when it is already in providerWarning / top message.
    const tow = di === 0 ? towingCapacityCaveat(need.note) : null;
    const noteParts = dedupeWarningMessages([emptyNote, emptyModelsNote, directionNote, tow, assumption]);
    groups.push({
      direction,
      listings,
      plannedModels: queriesForDirection(direction),
      searchedModels: succeeded.map((o) => ({ make: o.make, model: o.model })),
      failedModels: failed.map((o) => ({ make: o.make, model: o.model, outcome: o.outcome })),
      skippedModels: skipped,
      coverage: coverageExtra ? `${coverageBase} ${coverageExtra}` : coverageBase,
      coverageLevel: coverageIncomplete ? "low" : coverageConfidence(coverageInput),
      note: noteParts.join(" ") || null,
      providerWarning: directionWarning,
      queryOutcomes,
    });
  }

  let visible = groups.reduce((sum, group) => sum + group.listings.length, 0);

  // A zero-result search stays inside the shopper's radius. A wider search is offered
  // in the empty message and is never run silently. Non-cars are filtered above.

  // One comparable pool across badge + pick/score: use full provider returns for this
  // search (pre-diversify), not only the 24 shown cards, so same-model peers stay honest.
  const compsPool = compsPoolAcc;
  // Same uneven-comps gate as ranking — when true, card labels must not read as scored GOOD PRICE.
  const rankingPriceProvisional = priceCompsUnevenAcrossListings(
    groups.flatMap((group) => group.listings),
    compsPool,
  );
  for (const group of groups) {
    group.listings = await Promise.all(
      group.listings.map(async (item) => {
        const priceView = item.priceView;
        const usable = priceView?.usableForBudget !== false;
        if (!usable || item.priceUsd == null || !(item.vin && item.vin.length === 17)) {
          return {
            ...item,
            badge: priceBadge(
              usable ? item : { ...item, priceUsd: null },
              compsPool,
              { rankingPriceProvisional },
            ),
          };
        }
        // One record per VIN/ZIP/radius/day — Find badges from the returned record.
        const { badge } = await getOrComputeValuation({
          kv: deps.kv,
          vin: item.vin,
          // Buyer search scope only — never the dealer's listing ZIP (that made
          // nationwide Find comparisons say "near 33415").
          zip: radiusMiles != null ? searchZip ?? null : null,
          radiusMiles: radiusMiles,
          priceUsd: item.priceUsd,
          subject: item,
          pool: compsPool,
          source: "find",
          rankingPriceProvisional,
        });
        return { ...item, badge };
      }),
    );
    const coverageInput = {
      mode: need.mode,
      sample: false,
      dealerListingCount: group.listings.length,
      pageListingCount: visible,
      radiusMiles: radiusMiles,
      historyOnListing: false,
    };
    const base = coverageSentence(coverageInput);
    // Preserve any prior incomplete-search suffix after the base sentence.
    const prior = group.coverage ?? "";
    const incompleteBit = prior.includes("Coverage incomplete:")
      ? prior.slice(prior.indexOf("Coverage incomplete:"))
      : null;
    group.coverage = incompleteBit ? `${base} ${incompleteBit}` : base;
    if (!prior.includes("Coverage incomplete:")) {
      group.coverageLevel = coverageConfidence(coverageInput);
    }
  }
  const allOutcomes = groups.flatMap((g) => g.queryOutcomes);
  const resolved = resolveFindEmptyFromOutcomes(allOutcomes, visible);

  // Zero successful provider responses → hard-fail with truthful reason (never 200 empty_inventory).
  if (resolved?.hardFail) {
    const empty = findEmptyCopy(resolved.reason, need, resolved.observedMessage);
    return {
      ok: false,
      status: statusForFindEmpty(empty.reason),
      body: {
        error: empty.reason,
        emptyReason: empty.reason,
        message: empty.detail,
        headline: empty.headline,
        nextStep: empty.nextStep,
        scope: searchScopeLabel(need),
        partialFailure: Boolean(partialFailureWarning),
        directions: groups,
        providerQueriesUsed,
        geoScope,
      },
    };
  }

  let emptyReason: FindEmptyReason | null = null;
  let headline: string | null = null;
  let nextStep: string | null = null;
  // Never claim empty inventory / widen / year-filter misses when no provider query ran.
  if (visible === 0 && providerQueriesUsed === 0) {
    const empty = findEmptyCopy(
      "no_directions",
      need,
      "No listing search ran, so this is not an empty market and it is not a verdict.",
    );
    emptyReason = empty.reason;
    message = empty.detail;
    headline = empty.headline;
    nextStep = empty.nextStep;
  } else if (visible === 0 && resolved?.reason === "incomplete_search") {
    const empty = findEmptyCopy("incomplete_search", need, resolved.observedMessage);
    emptyReason = empty.reason;
    message = empty.detail;
    headline = empty.headline;
    nextStep = empty.nextStep;
    partialFailureWarning = empty.detail;
  } else if (visible === 0 && resolved?.reason === "empty_inventory") {
    const empty = findEmptyCopy("empty_inventory", need, resolved.observedMessage ?? groups[0]?.note ?? null);
    emptyReason = empty.reason;
    message = empty.detail;
    headline = empty.headline;
    nextStep = empty.nextStep;
  } else if (visible === 0 && resolved) {
    const empty = findEmptyCopy(resolved.reason, need, resolved.observedMessage);
    emptyReason = empty.reason;
    message = empty.detail;
    headline = empty.headline;
    nextStep = empty.nextStep;
  } else if (partialFailureWarning) {
    const parts = dedupeWarningMessages([
      "Some model searches failed. Showing only the live rows that returned.",
      partialFailureWarning,
    ]);
    message = parts.join(" ");
  }

  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      sample: false,
      emptyReason,
      message,
      headline,
      nextStep,
      scope: searchScopeLabel(need),
      affordabilityAssessed: need.budgetKnown,
      partialFailure: Boolean(partialFailureWarning),
      geoScope,
      directions: groups,
      compsPool,
      providerQueriesUsed,
    },
  };
}

export type { StructuredNeed };
