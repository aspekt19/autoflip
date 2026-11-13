/**
 * Map a finished Find/Resale chat body into a LiveEvalCaseResult.
 * Shared by the in-process CLI driver and the per-hop HTTP eval stepper.
 */
import { joinChosenListing } from "@/domain/join-chosen-listing";
import type { Listing } from "@/domain/types";
import { ESTIMATED_USD_PER_QUERY } from "./spend";
import type { GeneratedQuery, LiveEvalCaseResult, LiveEvalPick, LiveEvalServUsage } from "./types";

function pickLabel(
  year: number | null | undefined,
  make: string | null | undefined,
  model: string | null | undefined,
): string | null {
  const parts = [year, make, model].filter((part) => part != null && String(part).trim());
  return parts.length > 0 ? parts.join(" ") : null;
}

function listingVdp(listing: Listing | null | undefined): string | null {
  // Prefer the listing's own detail page from auto.dev; dealerUrl only as fallback.
  const vdp = listing?.vdp?.trim() || null;
  if (vdp) return vdp;
  const dealer = listing?.dealerUrl?.trim() || null;
  return dealer || null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function servUsageFromChat(agentLoop: Record<string, unknown> | null, result: Record<string, unknown> | null): LiveEvalServUsage | null {
  const raw = asRecord(agentLoop?.servUsageTotal) ?? asRecord(asRecord(result?.journalMeta)?.servUsageTotal);
  if (!raw || typeof raw.calls !== "number") return null;
  return {
    calls: raw.calls,
    input_tokens: typeof raw.input_tokens === "number" ? raw.input_tokens : 0,
    output_tokens: typeof raw.output_tokens === "number" ? raw.output_tokens : 0,
    total_tokens: typeof raw.total_tokens === "number" ? raw.total_tokens : 0,
    reasoning_tokens: typeof raw.reasoning_tokens === "number" ? raw.reasoning_tokens : 0,
    cached_tokens: typeof raw.cached_tokens === "number" ? raw.cached_tokens : 0,
    cost: typeof raw.cost === "number" ? raw.cost : null,
  };
}


function listingFromBest(best: Record<string, unknown> | null): Listing | null {
  const listing = best?.listing;
  if (listing && typeof listing === "object" && typeof (listing as Listing).vin === "string") {
    return listing as Listing;
  }
  return null;
}

export function settleFindChatCaseResult(input: {
  query: GeneratedQuery;
  drivenOk: boolean;
  body: Record<string, unknown>;
  elapsedMs: number;
  fixtureDir?: string | null;
}): LiveEvalCaseResult {
  const base: Omit<LiveEvalCaseResult, "ok" | "searchSpec" | "carsFound" | "pick" | "failure" | "proofRecords"> = {
    id: input.query.id,
    product: input.query.product ?? "find",
    note: input.query.note,
    elapsedMs: input.elapsedMs,
    durationMs: input.elapsedMs,
    estimatedUsd: ESTIMATED_USD_PER_QUERY,
    fixtureDir: input.fixtureDir ?? null,
  };

  const result =
    input.body.result && typeof input.body.result === "object"
      ? (input.body.result as Record<string, unknown>)
      : null;

  if (!input.drivenOk || !result) {
    return {
      ...base,
      ok: false,
      searchSpec: null,
      carsFound: 0,
      pick: null,
      failure: {
        step: "chat",
        error: typeof input.body.error === "string" ? input.body.error : "chat_failed",
        message:
          typeof input.body.message === "string"
            ? input.body.message
            : "Find chat did not deliver a verdict.",
      },
      proofRecords: [],
    };
  }

  const offerPool = Array.isArray(result.offerPool) ? (result.offerPool as Listing[]) : [];
  const offerByVin = new Map(offerPool.map((row) => [row.vin.toUpperCase(), row]));
  const agentLoop =
    result.agentLoop && typeof result.agentLoop === "object"
      ? (result.agentLoop as Record<string, unknown>)
      : null;
  const bestDeal =
    result.bestDeal && typeof result.bestDeal === "object"
      ? (result.bestDeal as {
          pick?: {
            vin?: string | null;
            key?: string | null;
            year?: number;
            make?: string;
            model?: string;
            priceUsd?: number;
            miles?: number;
            distanceMiles?: number | null;
          };
          confidence?: unknown;
        })
      : null;
  const pickAgentVerdict =
    result.pickAgentVerdict && typeof result.pickAgentVerdict === "object"
      ? (result.pickAgentVerdict as {
          verdict?: string | null;
          confidence?: unknown;
          pick?: { key?: string | null; label?: string | null };
        })
      : null;

  const pickVinRaw =
    bestDeal?.pick?.vin ?? bestDeal?.pick?.key ?? pickAgentVerdict?.pick?.key ?? null;
  const joined = joinChosenListing(typeof pickVinRaw === "string" ? pickVinRaw : null, offerByVin);
  const chosenVin =
    joined?.vin ?? (typeof pickVinRaw === "string" && pickVinRaw.trim() ? pickVinRaw : null);
  const listing = chosenVin ? offerByVin.get(chosenVin.toUpperCase()) ?? null : null;
  const verdict = pickAgentVerdict?.verdict ?? null;
  const confidence =
    pickAgentVerdict?.confidence != null
      ? String(pickAgentVerdict.confidence)
      : bestDeal?.confidence != null
        ? String(bestDeal.confidence)
        : null;
  const label =
    joined?.label ??
    pickAgentVerdict?.pick?.label ??
    pickLabel(bestDeal?.pick?.year, bestDeal?.pick?.make, bestDeal?.pick?.model);
  const passReason = typeof agentLoop?.passReason === "string" ? agentLoop.passReason : null;
  const carsFound =
    typeof agentLoop?.carsFound === "number" ? agentLoop.carsFound : offerPool.length;
  const toolRounds = typeof agentLoop?.toolRounds === "number" ? agentLoop.toolRounds : 0;
  const relaxedConditions = Array.isArray(agentLoop?.relaxedConditions)
    ? (agentLoop!.relaxedConditions as LiveEvalCaseResult["relaxedConditions"])
    : [];
  const verdictReachedFlag = agentLoop?.verdictReached === true;
  const nothingFits =
    !chosenVin &&
    verdictReachedFlag &&
    (verdict === "pass" || verdict == null) &&
    Boolean(passReason?.trim()) &&
    (relaxedConditions?.length ?? 0) > 0 &&
    toolRounds > 0;
  const verdictReached = Boolean(chosenVin) || nothingFits;
  const confirmedBrief =
    result.confirmedBrief && typeof result.confirmedBrief === "object"
      ? (result.confirmedBrief as Record<string, unknown> & { summary?: string })
      : null;
  const runId =
    typeof result.runId === "string" && result.runId.trim() ? result.runId.trim() : null;
  const pick: LiveEvalPick = {
    vin: chosenVin,
    label,
    verdict: typeof verdict === "string" ? verdict : chosenVin ? null : "pass",
    confidence,
    priceUsd: joined?.priceUsd ?? bestDeal?.pick?.priceUsd ?? null,
    miles: joined?.miles ?? bestDeal?.pick?.miles ?? null,
    distanceMiles: listing?.distanceMiles ?? bestDeal?.pick?.distanceMiles ?? null,
    vdp: listingVdp(listing),
  };

  const honestyMessage =
    typeof result.message === "string" && result.message.trim()
      ? result.message.trim()
      : typeof result.honesty === "string" && result.honesty.trim()
        ? result.honesty.trim()
        : null;
  const agentError = typeof result.error === "string" ? result.error : null;
  const incompleteFailure =
    !verdictReached
      ? {
          step: "chat" as const,
          // Prefer stored search-log honesty over a generic incomplete_verdict label.
          error:
            agentError === "missing_terminal" || honestyMessage
              ? agentError ?? "serv_no_terminal"
              : "incomplete_verdict",
          message:
            honestyMessage ||
            "No chosen listing and no documented nothing-fits (searches + reasons). Agent must repair.",
        }
      : null;

  return {
    ...base,
    ok: verdictReached,
    searchSpec: confirmedBrief?.summary
      ? { hard: {}, soft: {}, planSummary: confirmedBrief.summary }
      : null,
    carsFound,
    pick,
    failure: incompleteFailure,
    proofRecords: [],
    agentMode:
      typeof agentLoop?.agentMode === "string"
        ? (agentLoop.agentMode as "tools" | "next_action")
        : null,
    toolRounds,
    verdictReached,
    relaxedConditions,
    passReason,
    journalServCalls:
      typeof agentLoop?.journalServCalls === "number" ? agentLoop.journalServCalls : 0,
    journalToolCalls:
      typeof agentLoop?.journalToolCalls === "number" ? agentLoop.journalToolCalls : 0,
    servUsageTotal: servUsageFromChat(agentLoop, result),
    featuresActive: Array.isArray(agentLoop?.featuresActive)
      ? (agentLoop!.featuresActive as string[])
      : [],
    featuresActivePerCall: Array.isArray(agentLoop?.featuresActivePerCall)
      ? (agentLoop!.featuresActivePerCall as string[][])
      : [],
    featureRejections: Array.isArray(agentLoop?.featureRejections)
      ? (agentLoop!.featureRejections as string[])
      : [],
    chosenListingCount: chosenVin ? 1 : 0,
    servResponseIds: Array.isArray(agentLoop?.servResponseIds)
      ? (agentLoop!.servResponseIds as string[])
      : [],
    runId,
    confirmedBrief,
  };
}

export function settleResaleChatCaseResult(input: {
  query: GeneratedQuery;
  drivenOk: boolean;
  body: Record<string, unknown>;
  elapsedMs: number;
  fixtureDir?: string | null;
}): LiveEvalCaseResult {
  const base: Omit<LiveEvalCaseResult, "ok" | "searchSpec" | "carsFound" | "pick" | "failure" | "proofRecords"> = {
    id: input.query.id,
    product: "resale",
    note: input.query.note,
    elapsedMs: input.elapsedMs,
    durationMs: input.elapsedMs,
    estimatedUsd: ESTIMATED_USD_PER_QUERY,
    fixtureDir: input.fixtureDir ?? null,
  };

  const result =
    input.body.result && typeof input.body.result === "object"
      ? (input.body.result as Record<string, unknown>)
      : null;

  if (!input.drivenOk || !result) {
    return {
      ...base,
      ok: false,
      searchSpec: null,
      carsFound: 0,
      pick: null,
      failure: {
        step: "resale_chat",
        error: typeof input.body.error === "string" ? input.body.error : "chat_failed",
        message:
          typeof input.body.message === "string"
            ? input.body.message
            : "Resale chat did not deliver a verdict.",
      },
      proofRecords: [],
    };
  }

  const agentLoop =
    result.agentLoop && typeof result.agentLoop === "object"
      ? (result.agentLoop as Record<string, unknown>)
      : null;
  const best =
    result.best && typeof result.best === "object"
      ? (result.best as Record<string, unknown>)
      : null;
  const listing = listingFromBest(best);
  const chosenVin =
    typeof best?.vin === "string" && best.vin.trim()
      ? String(best.vin)
      : listing?.vin ?? null;
  const listingsByVin = new Map<string, Listing>();
  if (listing) listingsByVin.set(listing.vin.toUpperCase(), listing);
  const joined = chosenVin ? joinChosenListing(chosenVin, listingsByVin) : null;
  const passReason = !chosenVin
    ? typeof result.passReason === "string"
      ? result.passReason
      : typeof agentLoop?.passReason === "string"
        ? agentLoop.passReason
        : null
    : null;
  const toolRounds = typeof agentLoop?.toolRounds === "number" ? agentLoop.toolRounds : 0;
  const relaxedConditions = Array.isArray(agentLoop?.relaxedConditions)
    ? (agentLoop!.relaxedConditions as LiveEvalCaseResult["relaxedConditions"])
    : [];
  const verdictReachedFlag = agentLoop?.verdictReached === true;
  const nothingFits =
    !chosenVin &&
    verdictReachedFlag &&
    toolRounds > 0 &&
    (relaxedConditions?.length ?? 0) > 0 &&
    Boolean(passReason);
  const scoringOk = Boolean(chosenVin) || nothingFits;
  const carsFound =
    typeof agentLoop?.carsFound === "number" ? agentLoop.carsFound : listing ? 1 : 0;
  const agentVerdict =
    result.agentVerdict && typeof result.agentVerdict === "object"
      ? (result.agentVerdict as { verdict?: string | null })
      : null;
  const pickVerdict =
    typeof agentVerdict?.verdict === "string" && agentVerdict.verdict.trim()
      ? agentVerdict.verdict
      : chosenVin
        ? "buy"
        : "pass";
  const pick: LiveEvalPick = chosenVin
    ? {
        vin: chosenVin,
        label: joined?.label ?? null,
        verdict: pickVerdict,
        confidence: typeof best?.confidence === "string" ? best.confidence : null,
        priceUsd: joined?.priceUsd ?? listing?.priceUsd ?? null,
        miles: joined?.miles ?? listing?.miles ?? null,
        distanceMiles: listing?.distanceMiles ?? null,
        vdp: listingVdp(listing),
        askingUsd: typeof best?.askingUsd === "number" ? best.askingUsd : null,
        profitMidUsd: typeof best?.profitMidUsd === "number" ? best.profitMidUsd : null,
        profitLowUsd: typeof best?.profitLowUsd === "number" ? best.profitLowUsd : null,
        profitHighUsd: typeof best?.profitHighUsd === "number" ? best.profitHighUsd : null,
        resaleMidUsd: typeof best?.resaleMidUsd === "number" ? best.resaleMidUsd : null,
      }
    : {
        vin: null,
        label: null,
        verdict: "pass",
        confidence: typeof best?.confidence === "string" ? best.confidence : null,
        priceUsd: null,
        miles: null,
        distanceMiles: null,
        vdp: null,
      };
  const confirmedBrief =
    result.confirmedBrief && typeof result.confirmedBrief === "object"
      ? (result.confirmedBrief as Record<string, unknown> & { summary?: string })
      : null;
  const runId =
    typeof result.runId === "string" && result.runId.trim() ? result.runId.trim() : null;

  const honestyMessage =
    typeof result.message === "string" && result.message.trim()
      ? result.message.trim()
      : typeof result.honesty === "string" && result.honesty.trim()
        ? result.honesty.trim()
        : null;
  const agentError = typeof result.error === "string" ? result.error : null;
  const incompleteFailure =
    !scoringOk
      ? {
          step: "resale_chat" as const,
          error:
            agentError === "missing_terminal" || honestyMessage
              ? agentError ?? "serv_no_terminal"
              : "incomplete_verdict",
          message:
            honestyMessage ||
            "No chosen flip and no documented nothing-fits (searches + reasons). Agent must repair.",
        }
      : null;

  return {
    ...base,
    ok: scoringOk,
    searchSpec: confirmedBrief?.summary
      ? { hard: {}, soft: {}, planSummary: confirmedBrief.summary }
      : null,
    carsFound,
    pick,
    failure: incompleteFailure,
    proofRecords: [],
    agentMode:
      typeof agentLoop?.agentMode === "string"
        ? (agentLoop.agentMode as "tools" | "next_action")
        : null,
    toolRounds,
    verdictReached: Boolean(chosenVin) || nothingFits,
    relaxedConditions,
    passReason,
    journalServCalls:
      typeof agentLoop?.journalServCalls === "number" ? agentLoop.journalServCalls : 0,
    journalToolCalls:
      typeof agentLoop?.journalToolCalls === "number" ? agentLoop.journalToolCalls : 0,
    servUsageTotal: servUsageFromChat(agentLoop, result),
    featuresActive: Array.isArray(agentLoop?.featuresActive)
      ? (agentLoop!.featuresActive as string[])
      : Array.isArray(asRecord(result.journalMeta)?.featuresActive)
        ? (asRecord(result.journalMeta)!.featuresActive as string[])
        : [],
    featuresActivePerCall: Array.isArray(agentLoop?.featuresActivePerCall)
      ? (agentLoop!.featuresActivePerCall as string[][])
      : [],
    featureRejections: Array.isArray(agentLoop?.featureRejections)
      ? (agentLoop!.featureRejections as string[])
      : [],
    servResponseIds: Array.isArray(agentLoop?.servResponseIds)
      ? (agentLoop!.servResponseIds as string[])
      : [],
    chosenListingCount: chosenVin ? 1 : 0,
    runId,
    confirmedBrief,
  };
}
