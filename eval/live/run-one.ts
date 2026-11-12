/**
 * One live-eval Find query through the SERV chat intake.
 * Never charges report credits (skipCredit).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { joinChosenListing } from "@/domain/join-chosen-listing";
import type { Listing } from "@/domain/types";
import type { Kv } from "@/io/kv";
import { runtimeDeps } from "@/server/deps";
import { runFindChatTurn } from "@/server/find-chat";
import { createGoldenFetch } from "../../test/golden/transport";
import { driveServChatEval } from "./drive-chat";
import type { GeneratedQuery, LiveEvalCaseResult, LiveEvalPick } from "./types";

/** Rough spend model: chat intake + agent loop (search_listings + settle). */
export const SERV_CALLS_PER_QUERY = 4;
/** Conservative USD per SERV call for the eval hard cap (not a bill). */
export const USD_PER_SERV_CALL = 0.03;
export const ESTIMATED_USD_PER_QUERY = SERV_CALLS_PER_QUERY * USD_PER_SERV_CALL;

export type RunOneDeps = {
  kv: Kv;
  userId: string;
  fetchImpl?: typeof fetch;
  autodevKey?: string | null;
  servKey?: string | null;
  servModel?: string;
  servBaseUrl?: string;
  /** Golden record root for this case (absolute or cwd-relative). */
  fixtureRoot?: string;
  caseId?: string;
  secrets?: readonly string[];
};

export function liveKeysFromEnv(env: NodeJS.ProcessEnv = process.env): {
  ok: boolean;
  servKey: string | undefined;
  autodevKey: string | undefined;
  message: string | null;
} {
  const deps = runtimeDeps();
  const servKey = deps.servKey ?? (env.SERV_API_KEY?.trim() || undefined);
  const autodevKey = deps.autodevKey ?? (env.AUTODEV_API_KEY?.trim() || undefined);
  if (!servKey || !autodevKey) {
    return {
      ok: false,
      servKey,
      autodevKey,
      message: "Live mode needs SERV_API_KEY and AUTODEV_API_KEY.",
    };
  }
  return { ok: true, servKey, autodevKey, message: null };
}

function pickLabel(year: number | null | undefined, make: string | null | undefined, model: string | null | undefined): string | null {
  const parts = [year, make, model].filter((part) => part != null && String(part).trim());
  return parts.length > 0 ? parts.join(" ") : null;
}

function listingVdp(listing: Listing | null | undefined): string | null {
  const vdp = listing?.vdp?.trim() || listing?.dealerUrl?.trim() || null;
  return vdp || null;
}

export async function runOneQuery(
  query: GeneratedQuery,
  deps: RunOneDeps,
): Promise<LiveEvalCaseResult> {
  const started = Date.now();
  const base: Omit<LiveEvalCaseResult, "ok" | "searchSpec" | "carsFound" | "pick" | "failure" | "proofRecords"> = {
    id: query.id,
    product: query.product ?? "find",
    note: query.note,
    elapsedMs: 0,
    estimatedUsd: ESTIMATED_USD_PER_QUERY,
    fixtureDir: deps.fixtureRoot && deps.caseId ? `${deps.fixtureRoot}/${deps.caseId}` : null,
  };

  const keys = {
    servKey: deps.servKey ?? null,
    autodevKey: deps.autodevKey ?? null,
  };
  if (!keys.servKey || !keys.autodevKey) {
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
      secrets: deps.secrets ?? ([keys.servKey, keys.autodevKey].filter(Boolean) as string[]),
    });
    fetchImpl = golden.fetch;
  }

  const driven = await driveServChatEval({
    firstMessage: query.note,
    turn: (turn) =>
      runFindChatTurn({
        kv: deps.kv,
        userId: deps.userId,
        sessionId: turn.sessionId,
        message: turn.message,
        continue: turn.continue,
        confirmBrief: turn.confirmBrief,
        skipCredit: true,
        servKey: keys.servKey!,
        autodevKey: keys.autodevKey!,
        servBaseUrl: deps.servBaseUrl,
        fetchImpl,
      }),
  });

  const result = (driven.body.result && typeof driven.body.result === "object"
    ? (driven.body.result as Record<string, unknown>)
    : null);

  const settle = (row: LiveEvalCaseResult): LiveEvalCaseResult => {
    const finished = { ...row, elapsedMs: Date.now() - started, durationMs: Date.now() - started };
    if (deps.fixtureRoot && deps.caseId) {
      writeProvenance(deps.fixtureRoot, deps.caseId, {
        note: query.note,
        product: "find",
        ok: finished.ok,
        failure: finished.failure,
        pick: finished.pick,
        carsFound: finished.carsFound,
        asked: driven.asked,
        briefConfirmed: driven.briefConfirmed,
        hops: driven.hops,
        confirmedBrief: result?.confirmedBrief ?? null,
        at: new Date().toISOString(),
      });
    }
    return finished;
  };

  if (!driven.ok || !result) {
    return settle({
      ...base,
      ok: false,
      searchSpec: null,
      carsFound: 0,
      pick: null,
      failure: {
        step: "chat",
        error: typeof driven.body.error === "string" ? driven.body.error : "chat_failed",
        message:
          typeof driven.body.message === "string"
            ? driven.body.message
            : "Find chat did not deliver a verdict.",
      },
      proofRecords: [],
    });
  }

  const offerPool = Array.isArray(result.offerPool) ? (result.offerPool as Listing[]) : [];
  const offerByVin = new Map(offerPool.map((row) => [row.vin.toUpperCase(), row]));
  const agentLoop = (result.agentLoop && typeof result.agentLoop === "object"
    ? (result.agentLoop as Record<string, unknown>)
    : null);
  const bestDeal = (result.bestDeal && typeof result.bestDeal === "object"
    ? (result.bestDeal as { pick?: { vin?: string | null; key?: string | null; year?: number; make?: string; model?: string; priceUsd?: number; miles?: number }; confidence?: unknown })
    : null);
  const pickAgentVerdict = (result.pickAgentVerdict && typeof result.pickAgentVerdict === "object"
    ? (result.pickAgentVerdict as { verdict?: string | null; confidence?: unknown; pick?: { key?: string | null; label?: string | null } })
    : null);

  const pickVinRaw =
    bestDeal?.pick?.vin ??
    bestDeal?.pick?.key ??
    pickAgentVerdict?.pick?.key ??
    null;
  const joined = joinChosenListing(typeof pickVinRaw === "string" ? pickVinRaw : null, offerByVin);
  const chosenVin = joined?.vin ?? (typeof pickVinRaw === "string" && pickVinRaw.trim() ? pickVinRaw : null);
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
  const confirmedBrief = result.confirmedBrief && typeof result.confirmedBrief === "object"
    ? (result.confirmedBrief as { summary?: string })
    : null;
  const pick: LiveEvalPick = {
    vin: chosenVin,
    label,
    verdict: typeof verdict === "string" ? verdict : chosenVin ? null : "pass",
    confidence,
    priceUsd: joined?.priceUsd ?? bestDeal?.pick?.priceUsd ?? null,
    miles: joined?.miles ?? bestDeal?.pick?.miles ?? null,
    vdp: listingVdp(listing),
  };

  return settle({
    ...base,
    ok: verdictReached,
    searchSpec: confirmedBrief?.summary
      ? { hard: {}, soft: {}, planSummary: confirmedBrief.summary }
      : null,
    carsFound,
    pick,
    failure: verdictReached
      ? null
      : {
          step: "chat",
          error: "incomplete_verdict",
          message:
            "No chosen listing and no documented nothing-fits (searches + reasons). Agent must repair.",
        },
    proofRecords: [],
    agentMode: typeof agentLoop?.agentMode === "string" ? (agentLoop.agentMode as "tools" | "next_action") : null,
    toolRounds,
    verdictReached,
    relaxedConditions,
    passReason,
    journalServCalls: typeof agentLoop?.journalServCalls === "number" ? agentLoop.journalServCalls : 0,
    journalToolCalls: typeof agentLoop?.journalToolCalls === "number" ? agentLoop.journalToolCalls : 0,
    featuresActive: Array.isArray(agentLoop?.featuresActive) ? (agentLoop!.featuresActive as string[]) : [],
    featureRejections: Array.isArray(agentLoop?.featureRejections)
      ? (agentLoop!.featureRejections as string[])
      : [],
    chosenListingCount: chosenVin ? 1 : 0,
    servResponseIds: Array.isArray(agentLoop?.servResponseIds)
      ? (agentLoop!.servResponseIds as string[])
      : [],
  });
}

function writeProvenance(
  fixtureRoot: string,
  caseId: string,
  payload: Record<string, unknown>,
): void {
  const dir = path.join(fixtureRoot, caseId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "provenance.json"), `${JSON.stringify(payload, null, 2)}\n`);
}
