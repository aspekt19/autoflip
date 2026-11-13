/**
 * KV-backed stepped live-eval batch.
 * Each HTTP request runs at most one chat turn (or one resumable search step)
 * so Hobby maxDuration 300s is enough — same shape as /api/find/chat and
 * /api/resale/chat.
 */
import { randomUUID } from "node:crypto";
import type { Kv } from "@/io/kv";
import type { EvalLiveActiveChat } from "../../eval/live/step-chat";
import type { GeneratedQuery, LiveEvalCaseResult, LiveEvalReport } from "../../eval/live/types";
import {
  ESTIMATED_USD_PER_QUERY,
  SERV_CALLS_PER_QUERY,
  USD_PER_SERV_CALL,
} from "../../eval/live/spend";
import { countByProduct } from "../../eval/live/generate";

export const EVAL_LIVE_BATCH_TTL_SEC = 60 * 60 * 6; // 6h

export type EvalLiveBatchRecord = {
  v: 1;
  batchId: string;
  seed: number;
  maxQueries: number;
  maxUsd: number;
  queries: GeneratedQuery[];
  results: LiveEvalCaseResult[];
  /** Index of the query currently in progress (or next to start). */
  nextIndex: number;
  /** In-flight chat session for the current query; null between queries. */
  active: EvalLiveActiveChat | null;
  status: "running" | "completed";
  stoppedReason: LiveEvalReport["stoppedReason"];
  createdAt: string;
  updatedAt: string;
  exp: number;
  /** Eval-only; default "on". */
  servVerdictFeatures?: "on" | "off";
};

function batchKey(batchId: string): string {
  return `eval-live:batch:v1:${batchId}`;
}

export async function storeEvalLiveBatch(kv: Kv, batch: EvalLiveBatchRecord): Promise<void> {
  await kv.set(batchKey(batch.batchId), JSON.stringify(batch));
}

export async function readEvalLiveBatch(
  kv: Kv,
  batchId: string,
): Promise<EvalLiveBatchRecord | null> {
  const raw = await kv.get(batchKey(batchId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const batch = { ...(parsed as EvalLiveBatchRecord) };
    if (batch.active === undefined) batch.active = null;
    return batch;
  } catch {
    return null;
  }
}

export function createEvalLiveBatch(input: {
  seed: number;
  maxQueries: number;
  maxUsd: number;
  queries: GeneratedQuery[];
  servVerdictFeatures?: "on" | "off";
}): EvalLiveBatchRecord {
  const now = Date.now();
  const affordable = input.queries.filter(
    (_, i) => (i + 1) * ESTIMATED_USD_PER_QUERY <= input.maxUsd + 1e-9,
  );
  const stoppedReason: LiveEvalReport["stoppedReason"] =
    affordable.length < input.queries.length ? "max_usd" : null;
  return {
    v: 1,
    batchId: randomUUID().replace(/-/g, ""),
    seed: input.seed,
    maxQueries: input.maxQueries,
    maxUsd: input.maxUsd,
    queries: affordable,
    results: [],
    nextIndex: 0,
    active: null,
    status: "running",
    stoppedReason,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    exp: Math.floor(now / 1000) + EVAL_LIVE_BATCH_TTL_SEC,
    servVerdictFeatures: input.servVerdictFeatures === "off" ? "off" : "on",
  };
}

export function appendEvalLiveResult(
  batch: EvalLiveBatchRecord,
  result: LiveEvalCaseResult,
): EvalLiveBatchRecord {
  const results = [...batch.results, result];
  const nextIndex = batch.nextIndex + 1;
  const done = nextIndex >= batch.queries.length;
  let stoppedReason = batch.stoppedReason;
  if (done && !stoppedReason) {
    stoppedReason = results.length >= batch.maxQueries ? "max_queries" : "completed";
  }
  return {
    ...batch,
    results,
    nextIndex,
    active: null,
    status: done ? "completed" : "running",
    stoppedReason: done ? stoppedReason ?? "completed" : stoppedReason,
    updatedAt: new Date().toISOString(),
  };
}

export function withEvalLiveActive(
  batch: EvalLiveBatchRecord,
  active: EvalLiveActiveChat | null,
): EvalLiveBatchRecord {
  return {
    ...batch,
    active,
    updatedAt: new Date().toISOString(),
  };
}

export function evalLiveBatchToReport(batch: EvalLiveBatchRecord): LiveEvalReport {
  const counts = countByProduct(batch.queries);
  const estimatedUsd = batch.results.reduce((sum, r) => sum + r.estimatedUsd, 0);
  return {
    mode: "live",
    seed: batch.seed,
    maxQueries: batch.maxQueries,
    maxUsd: batch.maxUsd,
    estimatedUsd,
    servCallsAssumedPerQuery: SERV_CALLS_PER_QUERY,
    usdPerServCall: USD_PER_SERV_CALL,
    stoppedReason:
      batch.status === "completed"
        ? batch.stoppedReason ?? "completed"
        : batch.stoppedReason,
    generatedAt: batch.updatedAt,
    queries: batch.queries,
    results: batch.results,
    findCount: counts.find,
    resaleCount: counts.resale,
    servVerdictFeatures: batch.servVerdictFeatures === "off" ? "off" : "on",
  };
}
