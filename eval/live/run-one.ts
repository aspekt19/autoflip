/**
 * One live-eval Find query through the SERV chat intake.
 * Never charges report credits (skipCredit).
 *
 * Local CLI may drive multiple chat hops in-process. Production HTTP eval-live
 * steps one hop per request via eval/live/step-chat.ts instead.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Kv } from "@/io/kv";
import { runtimeDeps } from "@/server/deps";
import { runFindChatTurn } from "@/server/find-chat";
import { createGoldenFetch } from "../../test/golden/transport";
import { driveServChatEval, evalShopperReplyFromQuery } from "./drive-chat";
import { settleFindChatCaseResult } from "./settle-chat-result";
import {
  ESTIMATED_USD_PER_QUERY,
  SERV_CALLS_PER_QUERY,
  USD_PER_SERV_CALL,
} from "./spend";
import type { GeneratedQuery, LiveEvalCaseResult } from "./types";

export { ESTIMATED_USD_PER_QUERY, SERV_CALLS_PER_QUERY, USD_PER_SERV_CALL };

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

export async function runOneQuery(
  query: GeneratedQuery,
  deps: RunOneDeps,
): Promise<LiveEvalCaseResult> {
  const started = Date.now();
  const fixtureDir =
    deps.fixtureRoot && deps.caseId ? `${deps.fixtureRoot}/${deps.caseId}` : null;

  const keys = {
    servKey: deps.servKey ?? null,
    autodevKey: deps.autodevKey ?? null,
  };
  if (!keys.servKey || !keys.autodevKey) {
    return {
      id: query.id,
      product: query.product ?? "find",
      note: query.note,
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
      durationMs: Date.now() - started,
      estimatedUsd: ESTIMATED_USD_PER_QUERY,
      fixtureDir,
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
    genericReply: evalShopperReplyFromQuery(query),
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

  const result =
    driven.body.result && typeof driven.body.result === "object"
      ? (driven.body.result as Record<string, unknown>)
      : null;

  const finished = settleFindChatCaseResult({
    query,
    drivenOk: driven.ok,
    body: driven.body,
    elapsedMs: Date.now() - started,
    fixtureDir,
  });

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
