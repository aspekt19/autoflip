/**
 * One live-eval query through the real in-process Find pipeline.
 * never calls debitFindDelivery — no report credits.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { joinChosenListing } from "@/domain/join-chosen-listing";
import type { SearchSpec } from "@/domain/search-spec";
import type { Kv } from "@/io/kv";
import { runtimeDeps } from "@/server/deps";
import { runFindDecideOrchestrator } from "@/server/find-decide-orchestrator";
import {
  mintFindSearchContextRecord,
  updateFindSearchContext,
} from "@/server/find-search-context";
import { BASE_MODEL, profile } from "@/server/serv";
import { understandNeed } from "@/server/understand-need";
import { createGoldenFetch } from "../../test/golden/transport";
import type { GeneratedQuery, LiveEvalCaseResult, SearchSpecSummary } from "./types";
import { LIVE_EVAL_GENERIC_SHOPPER_REPLY } from "@/domain/serv-chat";

/** Rough spend model: understand + agent loop (search_listings + settle). */
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

function summarizeSpec(spec: SearchSpec | null, planSummary: string | null): SearchSpecSummary {
  if (!spec) {
    return { hard: {}, soft: {}, planSummary };
  }
  return {
    hard: { ...spec.hard },
    soft: {
      models: spec.soft.models,
      priorities: spec.soft.priorities,
      ...(spec.soft.drivetrain ? { drivetrain: spec.soft.drivetrain } : {}),
      ...(spec.soft.fuel ? { fuel: spec.soft.fuel } : {}),
      ...(spec.soft.bodyStyles ? { bodyStyles: spec.soft.bodyStyles } : {}),
    },
    planSummary,
  };
}

function pickLabel(year: number | null | undefined, make: string | null | undefined, model: string | null | undefined): string | null {
  const parts = [year, make, model].filter((part) => part != null && String(part).trim());
  return parts.length > 0 ? parts.join(" ") : null;
}

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

export async function runOneQuery(
  query: GeneratedQuery,
  deps: RunOneDeps,
): Promise<LiveEvalCaseResult> {
  const started = Date.now();
  const noteWithGenericReply = `${query.note}\n\n${LIVE_EVAL_GENERIC_SHOPPER_REPLY}`;
  const base: Omit<LiveEvalCaseResult, "ok" | "searchSpec" | "carsFound" | "pick" | "failure" | "proofRecords"> = {
    id: query.id,
    product: query.product ?? "find",
    note: noteWithGenericReply,
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

  const settle = (result: LiveEvalCaseResult): LiveEvalCaseResult => {
    const finished = { ...result, elapsedMs: Date.now() - started };
    if (deps.fixtureRoot && deps.caseId) {
      const proofs = finished.proofRecords;
      writeProvenance(deps.fixtureRoot, deps.caseId, {
        note: noteWithGenericReply,
        model: deps.servModel || BASE_MODEL,
        profiles: ["find_plan", "find_triage", "find_decide", "find_challenge"],
        profileTimeoutsMs: {
          find_plan: profile("find_plan").timeoutMs,
          find_triage: profile("find_triage").timeoutMs,
          find_decide: profile("find_decide").timeoutMs,
          find_challenge: profile("find_challenge").timeoutMs,
        },
        responseIds: proofs
          .map((row) =>
            row && typeof row === "object" && "servResponseId" in row
              ? (row as { servResponseId?: string | null }).servResponseId
              : null,
          )
          .filter((id): id is string => typeof id === "string" && id.length > 0),
        at: new Date().toISOString(),
        ok: finished.ok,
        failure: finished.failure,
        pick: finished.pick,
        carsFound: finished.carsFound,
      });
    }
    return finished;
  };

  const understood = await understandNeed(
    {
      text: noteWithGenericReply,
      mode: "personal",
      zip: query.zip,
      distanceMiles: query.distanceMiles,
    },
    {
      servKey: keys.servKey,
      servModel: deps.servModel,
      servBaseUrl: deps.servBaseUrl,
      fetchImpl,
    },
  );

  if (!understood.ok) {
    return settle({
      ...base,
      ok: false,
      searchSpec: null,
      carsFound: 0,
      pick: null,
      failure: {
        step: "understand",
        error: understood.error,
        message: understood.message,
        responseId: null,
      },
      proofRecords: [],
      elapsedMs: 0,
    });
  }

  const searchSpec = summarizeSpec(understood.searchSpec, understood.findPlan.summary || null);

  // No classic runFindMatch seed. SERV agent loop owns search via search_listings.
  let context = mintFindSearchContextRecord({
    userId: deps.userId,
    need: understood.need,
    listings: [],
    compsPool: [],
    servNextCheckEnabled: false,
  });
  context = await updateFindSearchContext(deps.kv, context, { decidePathEnabled: true });

  // Stepped agentic decide: re-enter until settled or hard failure (Hobby 300s per hop).
  let decided = await runFindDecideOrchestrator(
    { searchContextToken: context.token },
    {
      kv: deps.kv,
      userId: deps.userId,
      servKey: keys.servKey,
      autodevKey: keys.autodevKey,
      servModel: deps.servModel,
      servBaseUrl: deps.servBaseUrl,
      fetchImpl,
      env: process.env,
    },
  );
  for (let hop = 0; hop < 40 && decided.ok && decided.loop.continue; hop += 1) {
    decided = await runFindDecideOrchestrator(
      { searchContextToken: context.token },
      {
        kv: deps.kv,
        userId: deps.userId,
        servKey: keys.servKey,
        autodevKey: keys.autodevKey,
        servModel: deps.servModel,
        servBaseUrl: deps.servBaseUrl,
        fetchImpl,
        env: process.env,
      },
    );
  }

  if (!decided.ok) {
    return settle({
      ...base,
      ok: false,
      searchSpec,
      carsFound: 0,
      pick: null,
      failure: {
        step: "decide",
        error: decided.error,
        message: decided.message,
      },
      proofRecords: [...(understood.proofRecords ?? [])],
      elapsedMs: 0,
    });
  }

  const proofs = [...(understood.proofRecords ?? []), ...(decided.pickProofRecords ?? [])];
  const decideProof = decided.pickProofRecords?.find((row) => row.purpose === "find_decide");
  const decideFailed = decideProof != null && decideProof.status !== "ok";
  const verdict = decided.pickAgentVerdict?.verdict ?? null;
  const pickVin =
    decided.bestDeal?.pick?.vin ??
    decided.bestDeal?.pick?.key ??
    decided.pickAgentVerdict?.pick?.key ??
    null;
  const offerByVin = new Map(
    (decided.offerPool ?? []).map((row) => [row.vin.toUpperCase(), row]),
  );
  const joined = joinChosenListing(
    typeof pickVin === "string" ? pickVin : null,
    offerByVin,
  );
  const best = decided.bestDeal?.pick ?? null;
  const label =
    joined?.label ??
    decided.pickAgentVerdict?.pick?.label ??
    pickLabel(best?.year, best?.make, best?.model);
  const confidence =
    decided.pickAgentVerdict?.confidence != null
      ? String(decided.pickAgentVerdict.confidence)
      : decided.bestDeal?.confidence != null
        ? String(decided.bestDeal.confidence)
        : null;

  const agentLoop = decided.agentLoop ?? null;
  // Count from agent journal search results — never hardcode 0 when funnel kept rows.
  const carsFound = agentLoop?.carsFound ?? decided.offerPool?.length ?? 0;

  if (decideFailed) {
    return settle({
      ...base,
      ok: false,
      searchSpec,
      carsFound,
      pick: {
        vin: typeof pickVin === "string" ? pickVin : null,
        label,
        verdict: null,
        confidence: null,
        priceUsd: joined?.priceUsd ?? best?.priceUsd ?? null,
        miles: joined?.miles ?? best?.miles ?? null,
      },
      failure: {
        step: "decide",
        error: "decide_validation_failed",
        message: decideProof?.reason ?? "find_decide failed validation",
        responseId: decideProof?.servResponseId ?? null,
      },
      proofRecords: proofs,
      elapsedMs: 0,
      passReason: agentLoop?.passReason ?? null,
    });
  }

  const elapsed = Date.now() - started;
  const chosenVin = typeof pickVin === "string" && pickVin.trim() ? pickVin : null;
  const passReason = agentLoop?.passReason ?? null;
  const nothingFits =
    !chosenVin &&
    Boolean(agentLoop?.verdictReached) &&
    (verdict === "pass" || verdict == null) &&
    Boolean(passReason?.trim()) &&
    (agentLoop?.relaxedConditions?.length ?? 0) > 0 &&
    (agentLoop?.toolRounds ?? 0) > 0;
  const verdictReached = Boolean(chosenVin) || nothingFits;
  const scoringOk = verdictReached;
  return settle({
    ...base,
    ok: scoringOk,
    searchSpec,
    carsFound,
    pick: {
      vin: chosenVin,
      label,
      verdict: typeof verdict === "string" ? verdict : null,
      confidence,
      priceUsd: joined?.priceUsd ?? best?.priceUsd ?? null,
      miles: joined?.miles ?? best?.miles ?? null,
    },
    failure: scoringOk
      ? null
      : {
          step: "decide",
          error: "incomplete_verdict",
          message:
            "No chosen listing and no documented nothing-fits (searches + reasons). Agent must repair.",
        },
    proofRecords: proofs,
    elapsedMs: elapsed,
    durationMs: elapsed,
    agentMode: agentLoop?.agentMode ?? null,
    toolRounds: agentLoop?.toolRounds ?? 0,
    verdictReached,
    relaxedConditions: agentLoop?.relaxedConditions ?? [],
    passReason,
    journalServCalls: agentLoop?.journalServCalls ?? 0,
    journalToolCalls: agentLoop?.journalToolCalls ?? 0,
    featuresActive: agentLoop?.featuresActive ?? [],
    featureRejections: agentLoop?.featureRejections ?? [],
    chosenListingCount: chosenVin ? 1 : 0,
    servResponseIds:
      agentLoop?.servResponseIds ??
      proofs
        .map((row) =>
          row && typeof row === "object" && "servResponseId" in row
            ? (row as { servResponseId?: string | null }).servResponseId
            : null,
        )
        .filter((id): id is string => typeof id === "string" && id.length > 0),
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
