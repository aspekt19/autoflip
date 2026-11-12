/**
 * One live-eval query through the real in-process Find pipeline.
 * never calls debitFindDelivery — no report credits.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
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

  // No classic runFindMatch seed. SERV agent loop owns search via search_listings.
  const carsFound = 0;
  let context = mintFindSearchContextRecord({
    userId: deps.userId,
    need: understood.need,
    listings: [],
    compsPool: [],
    servNextCheckEnabled: false,
  });
  context = await updateFindSearchContext(deps.kv, context, { decidePathEnabled: true });

