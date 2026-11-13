/**
 * Load committed comparison / proof run files for the public Proof page.
 * Only returns rows with real provenance (run id, model, timestamp).
 * Never invents live scores; empty list → empty state.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import servCompareFile from "../../eval/results/proof-serv-compare-2026-11-13.json";
import snapshotServAbFile from "../../eval/results/snapshot-serv-ab-2026-11-13.json";

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

export type ProofPlainAnswer = {
  headline: string;
  verbatim: string;
  sourceUrl?: string;
};

export type ProofLemonlessAnswer = {
  pick: string;
  recommendation: string;
  whyThisCar: string;
  whyThisOffer: string;
  checked: string[];
  unknown: string[];
  rejected: string;
};

export type ProofVariant = {
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
  sourceUrl?: string;
  capture?: string;
};

export type ProofClaimCheck = {
  title: string;
  intro: string;
  findings: Array<{ claim: string; verdict: string; detail: string; href?: string }>;
};

export type ProofExample = {
  id: string;
  slug: string;
  title: string;
  query: string;
  seed: number;
  model: string;
  generatedAt: string;
  generatedAtLabel: string;
  prod: string;
  note: string;
  variantOrder: string[];
  variants: Record<string, ProofVariant>;
  answers: {
    plain_llm?: ProofPlainAnswer;
    features_off?: ProofLemonlessAnswer;
    features_on?: ProofLemonlessAnswer;
    perplexity?: ProofPlainAnswer;
  };
  criteria: ProofCriterion[];
  servFeaturesAdd: {
    title: string;
    intro: string;
    differences: Array<{ point: string; detail: string; links: ProofLink[] }>;
    same: string[];
  };
  plainLlmFabrication: ProofClaimCheck;
  perplexityCapture?: ProofClaimCheck;
  cost: {
    plain_llm: Record<string, unknown>;
    features_off: Record<string, unknown>;
    features_on: Record<string, unknown>;
    note: string;
  };
};


export type SnapshotComparisonProof = {
  metadata: {
    title: string;
    runId: number;
    runUrl: string;
    artifactId: number;
    artifactName: string;
    headSha: string;
    capturedAt: string;
    generatedAt: string;
    snapshotId: string;
    listingSearches: number;
    candidateCount: number;
    providersCalled: string[];
    providersNotCalled: string[];
    providerCost: string;
  };
  query: string;
  snapshot: {
    buyerZip: string;
    radiusMiles: number;
    askingPriceSearchCapUsd: number;
    mileageCap: number;
    candidates: Array<{
      vin: string;
      year: number;
      make: string;
      model: string;
      askingPriceUsd: number;
      miles: number;
      location: string;
      distanceMiles: number;
      listingReportedAccidents: number | null;
      titleBrand: string | null;
    }>;
    dataCaveats: string[];
  };
  arms: Record<"features_off" | "features_on", {
    responseId: string;
    requestedModel: string;
    responseModel: string;
    latencyMs: number;
    usage: { inputTokens: number; outputTokens: number; totalTokens: number };
    estimatedCostUsd: number;
    providerCostUsd: number | null;
    pick: {
      vin: string;
      year: number;
      make: string;
      model: string;
      askingPriceUsd: number;
      miles: number;
      distanceMiles: number;
      listingReportedAccidents: number | null;
    };
    openingOfferUsd: number | null;
    walkAwayUsd: number | null;
    rationale: string;
  }>;
  criteria: Array<{
    id: string;
    label: string;
    featuresOff: string;
    featuresOn: string;
    winner: string;
  }>;
  repeatRun?: {
    metadata: {
      runId: number;
      runUrl: string;
      artifactId: number;
      headSha: string;
      capturedAt: string;
      generatedAt: string;
      reason: string;
    };
    snapshotIdentical: boolean;
    sameCandidateCount: number;
    sameCandidateSet: boolean;
    arms: Record<"features_off" | "features_on", {
      responseId: string;
      requestedModel: string;
      responseModel: string;
      latencyMs: number;
      usage: { inputTokens: number; outputTokens: number; totalTokens: number; cachedTokens: number };
      estimatedCostUsd: number;
      pickVin: string;
      openingOfferUsd: number | null;
      walkAwayUsd: number | null;
    }>;
    criteriaResult: string;
    costEstimateUsd: number;
  };
  result: {
    totalCompletedRuns?: number;
    totalListingSearches?: number;
    totalServCalls?: number;
    completedRunsHarnessEstimateUsd?: number;
    repeatability?: string;
    score: string;
    conclusion: string;
    notableDifference: string;
    latency: string;
    cost: string;
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
  /** Live comparison examples (plain chat, Lemonless, and any captured third-party answers). */
  examples: ProofExample[];
  /** First committed example, when present. Kept so older tests can read one comparison. */
  servCompare: ProofExample | null;
  /** Separate frozen-snapshot SERV features-off/on comparison, with explicit data caveats. */
  snapshotComparison: SnapshotComparisonProof | null;
};

export const CANONICAL_VARIANT_ORDER = [
  "plain_llm",
  "features_off",
  "features_on",
  "perplexity",
] as const;

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

function isLink(value: unknown): value is ProofLink {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as ProofLink).label === "string" &&
      typeof (value as ProofLink).href === "string" &&
      (value as ProofLink).href.startsWith("http"),
  );
}

function variantOrderFor(variants: Record<string, ProofVariant>, listed?: unknown): string[] {
  const known = new Set(Object.keys(variants));
  const fromFile = Array.isArray(listed)
    ? listed.filter((key): key is string => typeof key === "string" && known.has(key))
    : [];
  const extras = CANONICAL_VARIANT_ORDER.filter((key) => known.has(key) && !fromFile.includes(key));
  const leftover = Object.keys(variants).filter((key) => !fromFile.includes(key) && !extras.includes(key as (typeof CANONICAL_VARIANT_ORDER)[number]));
  return [...fromFile, ...extras, ...leftover];
}

function parsePlainAnswer(raw: unknown): ProofPlainAnswer | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Partial<ProofPlainAnswer>;
  if (typeof row.headline !== "string" || !row.headline.trim()) return null;
  if (typeof row.verbatim !== "string" || !row.verbatim.trim()) return null;
  return {
    headline: row.headline,
    verbatim: row.verbatim,
    sourceUrl: typeof row.sourceUrl === "string" ? row.sourceUrl : undefined,
  };
}

function parseLemonlessAnswer(raw: unknown): ProofLemonlessAnswer | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Partial<ProofLemonlessAnswer>;
  if (typeof row.pick !== "string" || !row.pick.trim()) return null;
  if (typeof row.recommendation !== "string" || !row.recommendation.trim()) return null;
  if (typeof row.whyThisCar !== "string" || !row.whyThisCar.trim()) return null;
  if (typeof row.whyThisOffer !== "string" || !row.whyThisOffer.trim()) return null;
  if (!Array.isArray(row.checked) || row.checked.some((item) => typeof item !== "string") || row.checked.length === 0) {
    return null;
  }
  if (!Array.isArray(row.unknown) || row.unknown.some((item) => typeof item !== "string") || row.unknown.length === 0) {
    return null;
  }
  if (typeof row.rejected !== "string" || !row.rejected.trim()) return null;
  return {
    pick: row.pick,
    recommendation: row.recommendation,
    whyThisCar: row.whyThisCar,
    whyThisOffer: row.whyThisOffer,
    checked: row.checked,
    unknown: row.unknown,
    rejected: row.rejected,
  };
}

function parseClaimCheck(raw: unknown): ProofClaimCheck | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Partial<ProofClaimCheck>;
  if (typeof row.title !== "string" || typeof row.intro !== "string" || !Array.isArray(row.findings)) return null;
  if (row.findings.length === 0) return null;
  for (const finding of row.findings) {
    if (!finding || typeof finding.claim !== "string" || typeof finding.verdict !== "string" || typeof finding.detail !== "string") {
      return null;
    }
  }
  return row as ProofClaimCheck;
}

function parseExample(raw: unknown): ProofExample | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Partial<ProofExample> & { answers?: Record<string, unknown> };
  if (typeof row.query !== "string" || !row.query.trim()) return null;
  if (!Array.isArray(row.criteria) || row.criteria.length === 0) return null;
  if (!row.variants || typeof row.variants !== "object") return null;
  const variants = row.variants as Record<string, ProofVariant>;
  const required = ["plain_llm", "features_off", "features_on"];
  for (const key of required) {
    const variant = variants[key];
    if (!variant || typeof variant.pick !== "string" || !Array.isArray(variant.links)) return null;
  }
  const order = variantOrderFor(variants, (row as { variantOrder?: unknown }).variantOrder);
  for (const criterion of row.criteria) {
    if (!criterion?.cells) return null;
    for (const key of order) {
      const cell = criterion.cells[key];
      if (!cell || typeof cell.summary !== "string" || !Array.isArray(cell.links) || cell.links.length === 0) {
        return null;
      }
      if (!cell.links.every(isLink)) return null;
    }
    if (typeof criterion.winnerLabel !== "string" || typeof criterion.why !== "string") return null;
  }
  const answersRaw = row.answers ?? {};
  const plain = parsePlainAnswer(answersRaw.plain_llm);
  const featuresOff = parseLemonlessAnswer(answersRaw.features_off);
  const featuresOn = parseLemonlessAnswer(answersRaw.features_on);
  if (!plain || !featuresOff || !featuresOn) return null;
  const answers: ProofExample["answers"] = {
    plain_llm: plain,
    features_off: featuresOff,
    features_on: featuresOn,
  };
  if (order.includes("perplexity")) {
    const captured = parsePlainAnswer(answersRaw.perplexity);
    if (!captured) return null;
    answers.perplexity = captured;
  }
  const fabrication = parseClaimCheck(row.plainLlmFabrication);
  if (!fabrication) return null;
  const servFeaturesAdd = row.servFeaturesAdd;
  if (!servFeaturesAdd || !Array.isArray(servFeaturesAdd.differences) || !Array.isArray(servFeaturesAdd.same)) {
    return null;
  }
  return {
    id: typeof row.id === "string" ? row.id : "proof-example",
    slug: typeof row.slug === "string" ? row.slug : "example",
    title: typeof row.title === "string" ? row.title : "Comparison",
    query: row.query,
    seed: typeof row.seed === "number" ? row.seed : 0,
    model: typeof row.model === "string" ? row.model : "",
    generatedAt: typeof row.generatedAt === "string" ? row.generatedAt : "",
    generatedAtLabel: typeof row.generatedAtLabel === "string" ? row.generatedAtLabel : "",
    prod: typeof row.prod === "string" ? row.prod : "",
    note: typeof row.note === "string" ? row.note : "",
    variantOrder: order,
    variants,
    answers,
    criteria: row.criteria,
    servFeaturesAdd,
    plainLlmFabrication: fabrication,
    perplexityCapture: parseClaimCheck((row as { perplexityCapture?: unknown }).perplexityCapture) ?? undefined,
    cost: (row.cost ?? { plain_llm: {}, features_off: {}, features_on: {}, note: "" }) as ProofExample["cost"],
  };
}

export function loadServCompareProof(): ProofExample | null {
  const examples = loadProofExamples();
  return examples[0] ?? null;
}

export function loadProofExamples(): ProofExample[] {
  // Import the JSON so the serverless bundle includes it. process.cwd() read
  // works in local tests but is not enough on Vercel (Hobby traces omit loose files).
  const raw = (servCompareFile as unknown) ?? readJson(SERV_COMPARE_PROOF_PATH);
  if (!raw || typeof raw !== "object") return [];
  const bag = raw as { examples?: unknown; query?: unknown };
  const rows = Array.isArray(bag.examples) ? bag.examples : [raw];
  const examples: ProofExample[] = [];
  for (const row of rows) {
    const parsed = parseExample(row);
    if (parsed) examples.push(parsed);
  }
  return examples;
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

  const examples = loadProofExamples();
  const snapshotRaw = (snapshotServAbFile as unknown) ?? readJson("eval/results/snapshot-serv-ab-2026-11-13.json");
  const snapshotComparison =
    snapshotRaw && typeof snapshotRaw === "object" &&
    typeof (snapshotRaw as SnapshotComparisonProof).query === "string" &&
    typeof (snapshotRaw as SnapshotComparisonProof).metadata?.runUrl === "string"
      ? (snapshotRaw as SnapshotComparisonProof)
      : null;
  return {
    hasLiveComparisons: cases.length > 0,
    generatedAt: examples[0]?.generatedAt ?? generatedAt,
    cases,
    committedTraces,
    examples,
    servCompare: examples[0] ?? null,
    snapshotComparison,
  };
}
