/**
 * Load committed comparison / proof run files for the public Proof page.
 * Only returns rows with real provenance (run id, model, timestamp).
 * Never invents live scores; empty list → empty state.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

export type ProofRunArm = {
  arm: string;
  status: string;
  runId: string | null;
  model: string | null;
  timestamp: string | null;
  rawResponse: string | null;
  costUsd: number | null;
  qualityNote: string | null;
};

export type ProofComparisonCase = {
  caseId: string;
  title: string;
  synthetic: boolean;
  arms: ProofRunArm[];
};

export type ProofPageData = {
  hasLiveComparisons: boolean;
  generatedAt: string | null;
  cases: ProofComparisonCase[];
  /** Single committed SERV proof traces (not multi-arm), when present. */
  committedTraces: Array<{
    id: string;
    generatedAt: string;
    model: string | null;
    runId: string | null;
    disclosure: string;
    decision: string | null;
  }>;
};

function readJson(rel: string): unknown | null {
  const full = path.join(process.cwd(), rel);
  if (!existsSync(full)) return null;
  try {
    return JSON.parse(readFileSync(full, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function armFromOutput(output: Record<string, unknown>, generatedAt: string | null): ProofRunArm | null {
  const arm = typeof output.arm === "string" ? output.arm : null;
  const status = typeof output.status === "string" ? output.status : "unknown";
  if (!arm) return null;
  const runId =
    (typeof output.runId === "string" && output.runId) ||
    (typeof output.responseId === "string" && output.responseId) ||
    (typeof output.servResponseId === "string" && output.servResponseId) ||
    null;
  const model = typeof output.model === "string" ? output.model : null;
  const timestamp =
    (typeof output.timestamp === "string" && output.timestamp) ||
    (typeof output.recordedAt === "string" && output.recordedAt) ||
    generatedAt;
  const rawResponse = typeof output.rawResponse === "string" ? output.rawResponse : null;
  const costUsd = typeof output.costUsd === "number" && Number.isFinite(output.costUsd) ? output.costUsd : null;
  // Live arms need provenance; not_run / fixture stubs are listed but flagged.
  return {
    arm,
    status,
    runId,
    model,
    timestamp,
    rawResponse,
    costUsd,
    qualityNote: typeof output.qualityNote === "string" ? output.qualityNote : null,
  };
}

/**
 * A comparison arm is "real" only when it ran with a run/response id + model + timestamp.
 * Synthetic fixture case ids must use the synthetic-test-* prefix or synthetic:true.
 */
export function isProvenancedArm(arm: ProofRunArm): boolean {
  if (arm.status !== "ran" && arm.status !== "ok") return false;
  return Boolean(arm.runId && arm.model && arm.timestamp);
}

export function loadProofPageData(): ProofPageData {
  const comparison = readJson("eval/results/comparison-latest.json") as {
    hasLiveScores?: boolean;
    generatedAt?: string;
    cases?: Array<{
      caseId?: string;
      title?: string;
      synthetic?: boolean;
      outputs?: Array<Record<string, unknown>>;
    }>;
  } | null;

  const generatedAt = comparison?.generatedAt ?? null;
  const cases: ProofComparisonCase[] = [];
  if (comparison?.hasLiveScores === true && Array.isArray(comparison.cases)) {
    for (const row of comparison.cases) {
      if (!row?.caseId || !Array.isArray(row.outputs)) continue;
      const arms = row.outputs
        .map((o) => armFromOutput(o, generatedAt))
        .filter((a): a is ProofRunArm => Boolean(a))
        .filter(isProvenancedArm);
      if (arms.length === 0) continue;
      const synthetic =
        row.synthetic === true ||
        row.caseId.startsWith("synthetic-test-") ||
        row.caseId.startsWith("find-") ||
        row.caseId.startsWith("check-");
      cases.push({
        caseId: row.caseId,
        title: row.title ?? row.caseId,
        synthetic,
        arms,
      });
    }
  }

  const committedTraces: ProofPageData["committedTraces"] = [];
  const trace = readJson("eval/results/serv-proof-trace.json") as {
    generatedAt?: string;
    disclosure?: string;
    result?: { decision?: string };
    response?: { id?: string; model?: string };
  } | null;
  if (trace?.generatedAt && trace.response?.id && trace.response?.model) {
    committedTraces.push({
      id: "serv-proof-trace",
      generatedAt: trace.generatedAt,
      model: trace.response.model,
      runId: trace.response.id,
      disclosure: trace.disclosure ?? "Committed SERV proof trace.",
      decision: trace.result?.decision ?? null,
    });
  }

  return {
    hasLiveComparisons: cases.length > 0,
    generatedAt,
    cases,
    committedTraces,
  };
}
