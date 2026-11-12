/**
 * One live-eval Resale query through the SERV chat intake.
 * Never charges report credits (skipCredit).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { joinChosenListing } from "@/domain/join-chosen-listing";
import type { Listing } from "@/domain/types";
import { runResaleChatTurn } from "@/server/resale-chat";
import { createGoldenFetch } from "../../test/golden/transport";
import { driveServChatEval } from "./drive-chat";
import { ESTIMATED_USD_PER_QUERY, type RunOneDeps } from "./run-one";
import type { GeneratedQuery, LiveEvalCaseResult, LiveEvalPick } from "./types";

function listingFromBest(best: Record<string, unknown> | null): Listing | null {
  const listing = best?.listing;
  if (listing && typeof listing === "object" && typeof (listing as Listing).vin === "string") {
    return listing as Listing;
  }
  return null;
}

function listingVdp(listing: Listing | null | undefined): string | null {
  return listing?.vdp?.trim() || listing?.dealerUrl?.trim() || null;
}

export async function runOneResaleQuery(
  query: GeneratedQuery,
  deps: RunOneDeps,
): Promise<LiveEvalCaseResult> {
  const started = Date.now();
  const base: Omit<LiveEvalCaseResult, "ok" | "searchSpec" | "carsFound" | "pick" | "failure" | "proofRecords"> = {
    id: query.id,
    product: "resale",
    note: query.note,
    elapsedMs: 0,
    estimatedUsd: ESTIMATED_USD_PER_QUERY,
    fixtureDir: deps.fixtureRoot && deps.caseId ? `${deps.fixtureRoot}/${deps.caseId}` : null,
  };

  const servKey = deps.servKey ?? null;
  const autodevKey = deps.autodevKey ?? null;
  if (!servKey || !autodevKey) {
    return {
      ...base,
      ok: false,
      searchSpec: null,
      carsFound: 0,
      pick: null,
      failure: {
        step: "missing_keys",
        error: "missing_keys",
        message: "SERV_API_KEY and AUTODEV_API_KEY required for live eval.",
      },
      proofRecords: [],
      elapsedMs: Date.now() - started,
    };
  }

  let fetchImpl = deps.fetchImpl ?? fetch;
  if (deps.fixtureRoot && deps.caseId) {
    const golden = await createGoldenFetch({
      mode: "record",
      caseId: deps.caseId,
      root: deps.fixtureRoot,
      liveFetch: fetchImpl,
      secrets: deps.secrets ?? ([servKey, autodevKey].filter(Boolean) as string[]),
    });
    fetchImpl = golden.fetch;
  }

  const driven = await driveServChatEval({
    firstMessage: query.note,
    turn: (turn) =>
      runResaleChatTurn({
        kv: deps.kv,
        userId: deps.userId,
        sessionId: turn.sessionId,
        message: turn.message,
        continue: turn.continue,
        confirmBrief: turn.confirmBrief,
        skipCredit: true,
        servKey,
        autodevKey,
        servBaseUrl: deps.servBaseUrl,
        fetchImpl,
      }),
  });

  const result = (driven.body.result && typeof driven.body.result === "object"
    ? (driven.body.result as Record<string, unknown>)
    : null);
  const elapsedMs = Date.now() - started;

  if (deps.fixtureRoot && deps.caseId) {
    const dir = path.join(deps.fixtureRoot, deps.caseId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "provenance.json"),
      `${JSON.stringify(
        {
          product: "resale",
          note: query.note,
          ok: driven.ok,
          asked: driven.asked,
          briefConfirmed: driven.briefConfirmed,
          hops: driven.hops,
          confirmedBrief: result?.confirmedBrief ?? null,
        },
        null,
        2,
      )}\n`,
    );
  }

  if (!driven.ok || !result) {
    return {
      ...base,
      ok: false,
      searchSpec: null,
      carsFound: 0,
      pick: null,
      failure: {
        step: "resale_chat",
        error: typeof driven.body.error === "string" ? driven.body.error : "chat_failed",
        message:
          typeof driven.body.message === "string"
            ? driven.body.message
            : "Resale chat did not deliver a verdict.",
      },
      proofRecords: [],
      elapsedMs,
      durationMs: elapsedMs,
    };
  }

  const agentLoop = (result.agentLoop && typeof result.agentLoop === "object"
    ? (result.agentLoop as Record<string, unknown>)
    : null);
  const best = (result.best && typeof result.best === "object" ? (result.best as Record<string, unknown>) : null);
  const listing = listingFromBest(best);
  const chosenVin = typeof best?.vin === "string" && best.vin.trim() ? String(best.vin) : listing?.vin ?? null;
  const listingsByVin = new Map<string, Listing>();
  if (listing) listingsByVin.set(listing.vin.toUpperCase(), listing);
  const joined = chosenVin ? joinChosenListing(chosenVin, listingsByVin) : null;
  const passReason = !chosenVin
    ? (typeof result.passReason === "string" ? result.passReason : typeof agentLoop?.passReason === "string" ? agentLoop.passReason : null)
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
    typeof agentLoop?.carsFound === "number"
      ? agentLoop.carsFound
      : listing
        ? 1
        : 0;
  const pick: LiveEvalPick = chosenVin
    ? {
        vin: chosenVin,
        label: joined?.label ?? null,
        verdict: "buy",
        confidence: typeof best?.confidence === "string" ? best.confidence : null,
        priceUsd: joined?.priceUsd ?? listing?.priceUsd ?? null,
        miles: joined?.miles ?? listing?.miles ?? null,
        vdp: listingVdp(listing),
      }
    : {
        vin: null,
        label: null,
        verdict: "pass",
        confidence: typeof best?.confidence === "string" ? best.confidence : null,
        priceUsd: null,
        miles: null,
        vdp: null,
      };
  const confirmedBrief = result.confirmedBrief && typeof result.confirmedBrief === "object"
    ? (result.confirmedBrief as { summary?: string })
    : null;

  return {
    ...base,
    ok: scoringOk,
    searchSpec: confirmedBrief?.summary
      ? { hard: {}, soft: {}, planSummary: confirmedBrief.summary }
      : null,
    carsFound,
    pick,
    failure: scoringOk
      ? null
      : {
          step: "resale_chat",
          error: "incomplete_verdict",
          message:
            "No chosen flip and no documented nothing-fits (searches + reasons). Agent must repair.",
        },
    proofRecords: [],
    elapsedMs,
    durationMs: elapsedMs,
    agentMode: typeof agentLoop?.agentMode === "string" ? (agentLoop.agentMode as "tools" | "next_action") : null,
    toolRounds,
    verdictReached: Boolean(chosenVin) || nothingFits,
    relaxedConditions,
    passReason,
    journalServCalls: typeof agentLoop?.journalServCalls === "number" ? agentLoop.journalServCalls : 0,
    journalToolCalls: typeof agentLoop?.journalToolCalls === "number" ? agentLoop.journalToolCalls : 0,
    chosenListingCount: chosenVin ? 1 : 0,
  };
}
