/**
 * Load committed comparison / proof run files for the public Proof page.
 * Only returns rows with real provenance (run id, model, timestamp).
 * Never invents live scores; empty list → empty state.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import servCompareFile from "../../eval/results/proof-serv-compare-2026-11-13.json";

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

export type ProofLink = { label: string; href: string };

export type ProofCompareCell = {
  summary: string;
  links: ProofLink[];
};

export type ProofCriterion = {
  id: string;
  label: string;
  cells: Record<string, ProofCompareCell>;
  winner: string;
  winnerLabel: string;
  why: string;
};

export type ProofServCompare = {
  id: string;
  query: string;
  seed: number;
  model: string;
  generatedAt: string;
  generatedAtLabel: string;
  prod: string;
  note: string;
  variants: Record<string, {
    label: string;
    short: string;
    description: string;
    pick: string;
    links: ProofLink[];
    runId?: string | null;
    responseId?: string | null;
    servVerdictFeatures?: string;
    servCalls?: number;
    featuresActive?: string[];
  }>;
  criteria: ProofCriterion[];
  servFeaturesAdd: {
    title: string;
    intro: string;
    differences: Array<{ point: string; detail: string; links: ProofLink[] }>;
    same: string[];
  };
  plainLlmFabrication: {
    title: string;
    intro: string;
    findings: Array<{ claim: string; verdict: string; detail: string; href?: string }>;
  };
  cost: {
    plain_llm: Record<string, unknown>;
    features_off: Record<string, unknown>;
    features_on: Record<string, unknown>;
    note: string;
  };
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
  /** Live 3-variant SERV comparison (plain LLM vs features off vs features on). */
  servCompare: ProofServCompare | null;
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

export const SERV_COMPARE_PROOF_PATH = "eval/results/proof-serv-compare-2026-11-13.json";

export function loadServCompareProof(): ProofServCompare | null {
  // Import the JSON so the serverless bundle includes it. process.cwd() read
  // works in local tests but is not enough on Vercel (Hobby traces omit loose files).
  const raw = (servCompareFile as unknown) ?? readJson(SERV_COMPARE_PROOF_PATH);
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Partial<ProofServCompare>;
  if (typeof row.query !== "string" || !row.query.trim()) return null;
  if (!Array.isArray(row.criteria) || row.criteria.length === 0) return null;
  if (!row.variants || typeof row.variants !== "object") return null;
  const required = ["plain_llm", "features_off", "features_on"];
  for (const key of required) {
    const v = (row.variants as Record<string, { pick?: unknown }>)[key];
    if (!v || typeof v.pick !== "string") return null;
  }
  for (const criterion of row.criteria) {
    if (!criterion?.cells) return null;
    for (const key of required) {
      const cell = criterion.cells[key];
      if (!cell || typeof cell.summary !== "string" || !Array.isArray(cell.links) || cell.links.length === 0) {
        return null;
      }
    }
  }
  return row as ProofServCompare;
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

  const servCompare = loadServCompareProof();
  return {
    hasLiveComparisons: cases.length > 0,
    generatedAt: servCompare?.generatedAt ?? generatedAt,
    cases,
    committedTraces,
    servCompare,
  };
}
