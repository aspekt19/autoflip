/**
 * One live-eval Resale query through the SERV chat intake.
 * Never charges report credits (skipCredit).
 *
 * Local CLI may drive multiple chat hops in-process. Production HTTP eval-live
 * steps one hop per request via eval/live/step-chat.ts instead.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runResaleChatTurn } from "@/server/resale-chat";
import { createGoldenFetch } from "../../test/golden/transport";
import { driveServChatEval } from "./drive-chat";
import type { RunOneDeps } from "./run-one";
import { ESTIMATED_USD_PER_QUERY } from "./spend";
import { settleResaleChatCaseResult } from "./settle-chat-result";
import type { GeneratedQuery, LiveEvalCaseResult } from "./types";

export async function runOneResaleQuery(
  query: GeneratedQuery,
  deps: RunOneDeps,
): Promise<LiveEvalCaseResult> {
  const started = Date.now();
  const fixtureDir =
    deps.fixtureRoot && deps.caseId ? `${deps.fixtureRoot}/${deps.caseId}` : null;

  const servKey = deps.servKey ?? null;
  const autodevKey = deps.autodevKey ?? null;
  if (!servKey || !autodevKey) {
    return {
      id: query.id,
      product: "resale",
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

  const result =
    driven.body.result && typeof driven.body.result === "object"
      ? (driven.body.result as Record<string, unknown>)
      : null;
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

  return settleResaleChatCaseResult({
    query,
    drivenOk: driven.ok,
    body: driven.body,
    elapsedMs,
    fixtureDir,
  });
}
