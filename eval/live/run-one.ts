/**
 * One live-eval query through the real in-process Find pipeline.
 * never calls debitFindDelivery — no report credits.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SearchSpec } from "@/domain/search-spec";
import { TtlCache } from "@/io/cache";
import type { Kv } from "@/io/kv";
import { MemoryCounter } from "@/io/quota";
import { runtimeDeps } from "@/server/deps";
import { runFindDecideOrchestrator } from "@/server/find-decide-orchestrator";
import { runFindMatch } from "@/server/find-match";
import {
  listingFactsFromCompsPool,
  listingsFromMatchDirections,
  mintFindSearchContextRecord,
  updateFindSearchContext,
} from "@/server/find-search-context";
import { BASE_MODEL, profile } from "@/server/serv";
import { understandNeed } from "@/server/understand-need";
import { createGoldenFetch } from "../../test/golden/transport";
import type { GeneratedQuery, LiveEvalCaseResult, SearchSpecSummary } from "./types";

/** Rough spend model: find_plan + find_triage + find_decide + find_challenge. */
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
  const base: Omit<LiveEvalCaseResult, "ok" | "searchSpec" | "carsFound" | "pick" | "failure" | "proofRecords"> = {
    id: query.id,
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

  const settle = (result: LiveEvalCaseResult): LiveEvalCaseResult => {
    const finished = { ...result, elapsedMs: Date.now() - started };
    if (deps.fixtureRoot && deps.caseId) {
      const proofs = finished.proofRecords;
      writeProvenance(deps.fixtureRoot, deps.caseId, {
        note: query.note,
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
      text: query.note,
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

  const match = await runFindMatch(
    {
      need: understood.need,
      directions: understood.directions,
      findPlan: understood.findPlan,
    },
    {
      autodevKey: keys.autodevKey,
      servKey: keys.servKey,
      servModel: deps.servModel,
      servBaseUrl: deps.servBaseUrl,
      fetch: fetchImpl,
      autodev: {
        cache: new TtlCache<unknown>(),
        counter: new MemoryCounter(),
      },
      kv: deps.kv,
      // Local CLI is not serverless; MemoryKv is fine. HTTP uses getKv().
      env: { VERCEL: undefined },
      parallelProviderQueries: true,
    },
  );

  if (!match.ok) {
    return settle({
      ...base,
      ok: false,
      searchSpec,
      carsFound: 0,
      pick: null,
      failure: {
        step: "match",
        error: String(match.body.error ?? "match_failed"),
        message: String(match.body.message ?? "Inventory search failed."),
      },
      proofRecords: understood.proofRecords ?? [],
      elapsedMs: 0,
    });
  }

  const listings = match.body.directions.flatMap((group) => group.listings);
  const carsFound = listings.length;
  if (carsFound === 0) {
    return settle({
      ...base,
      ok: true,
      searchSpec,
      carsFound: 0,
      pick: null,
      failure: null,
      proofRecords: understood.proofRecords ?? [],
      elapsedMs: 0,
    });
  }

  const shown = listingsFromMatchDirections(match.body.directions);
  const compsPool =
    match.body.compsPool.length > 0 ? listingFactsFromCompsPool(match.body.compsPool) : shown;
  let context = mintFindSearchContextRecord({
    userId: deps.userId,
    need: understood.need,
    listings: shown,
    compsPool,
    servNextCheckEnabled: false,
  });
  context = await updateFindSearchContext(deps.kv, context, { decidePathEnabled: true });

  const decided = await runFindDecideOrchestrator(
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

  if (!decided.ok) {
    return settle({
      ...base,
      ok: false,
      searchSpec,
      carsFound,
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
  const label =
    decided.pickAgentVerdict?.pick?.label ??
    pickLabel(
      decided.bestDeal?.pick?.year,
      decided.bestDeal?.pick?.make,
      decided.bestDeal?.pick?.model,
    );
  const confidence =
    decided.pickAgentVerdict?.confidence != null
      ? String(decided.pickAgentVerdict.confidence)
      : decided.bestDeal?.confidence != null
        ? String(decided.bestDeal.confidence)
        : null;

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
      },
      failure: {
        step: "decide",
        error: "decide_validation_failed",
        message: decideProof?.reason ?? "find_decide failed validation",
        responseId: decideProof?.servResponseId ?? null,
      },
      proofRecords: proofs,
      elapsedMs: 0,
    });
  }

  const agentLoop = decided.agentLoop ?? null;
  return settle({
    ...base,
    ok: true,
    searchSpec,
    carsFound,
    pick: {
      vin: typeof pickVin === "string" ? pickVin : null,
      label,
      verdict: typeof verdict === "string" ? verdict : null,
      confidence,
    },
    failure: null,
    proofRecords: proofs,
    elapsedMs: 0,
    agentMode: agentLoop?.agentMode ?? null,
    toolRounds: agentLoop?.toolRounds ?? 0,
    verdictReached: agentLoop?.verdictReached ?? Boolean(verdict),
    relaxedConditions: agentLoop?.relaxedConditions ?? [],
    journalServCalls: agentLoop?.journalServCalls ?? 0,
    journalToolCalls: agentLoop?.journalToolCalls ?? 0,
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
