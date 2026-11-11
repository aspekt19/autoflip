/**
 * Live Find close-call multipath — SERV find_close_call_multipath for near ties.
 * Code reconcileMultipathDeterministic is fallback only (never invents keys).
 */

import {
  buildMultipathResultFromServ,
  parseAgentMultipathPayload,
  reconcileMultipathDeterministic,
  type AgentMultipathCandidate,
} from "@/domain/agent-multipath";
import type { AgentMultipathResult } from "@/domain/agent-verdict-schema";
import type { BestDealCandidate } from "@/domain/find-best-deal";
import { annualFuelUsdFromFactor } from "@/domain/build-find-agent-verdict";
import { closeCallCars } from "@/domain/find-close-call";
import {
  buildDecisionProofRecord,
  VERDICT_RUBRIC_ID,
  type DecisionProofRecord,
} from "@/domain/decision-proof-record";
import { providerResponseIdFromCall } from "@/domain/serv-response-id";
import { chatCompletionContent, runServ } from "@/server/serv";

export type FindCloseCallServResult = {
  multipath: AgentMultipathResult | null;
  /** Allowlisted final pick from SERV (or code fallback) when a close group exists. */
  finalPickKey: string | null;
  source: "serv" | "code" | "skipped";
  proofRecords: DecisionProofRecord[];
};

function candidatesFromCars(cars: readonly BestDealCandidate[]): AgentMultipathCandidate[] {
  return cars.map((car) => {
    const recallPoints = car.factors.find((f) => f.id === "mmy_recall_campaigns")?.points;
    const fuelUsd = annualFuelUsdFromFactor(
      car.factors.find((f) => f.id === "estimated_fuel_cost")?.detail ?? "",
    );
    return {
      key: car.key,
      label: `${car.year} ${car.make} ${car.model}`,
      askUsd: car.priceUsd,
      riskScore: recallPoints == null ? null : -recallPoints,
      totalCostUsd: car.priceUsd != null && fuelUsd != null ? Math.round(car.priceUsd + fuelUsd) : null,
      evidenceIds: [
        `car:${car.key}`,
        `ask:${car.key}`,
        `fair:${car.key}`,
        `comps:${car.key}`,
        `miles:${car.key}`,
        `history:${car.key}`,
        `recalls:${car.key}`,
        `listing:${car.key}`,
      ],
    };
  });
}

/**
 * When the shortlist has a near tie, call SERV find_close_call_multipath.
 * Falls back to deterministic code reconciliation when SERV is missing or unusable.
 */
export async function runFindCloseCallMultipathServ(input: {
  cars: readonly BestDealCandidate[];
  servKey?: string | null;
  servBaseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  transportPolicy?: "production" | "experiment_single_attempt";
}): Promise<FindCloseCallServResult> {
  const recordedAt = new Date().toISOString();
  const tied = closeCallCars(input.cars);
  const pool = tied.length >= 2 ? tied : [];
  if (pool.length < 2) {
    return { multipath: null, finalPickKey: null, source: "skipped", proofRecords: [] };
  }

  const candidates = candidatesFromCars(pool);
  const allowedKeys = new Set(candidates.map((c) => c.key));
  const allowedEvidence = new Set(candidates.flatMap((c) => c.evidenceIds));
  const codeFallback = reconcileMultipathDeterministic(candidates);

  const servKey = input.servKey?.trim() || "";
  if (!servKey) {
    return {
      multipath: codeFallback,
      finalPickKey: codeFallback?.finalPickKey ?? null,
      source: "code",
      proofRecords: [
        buildDecisionProofRecord({
          purpose: "find_close_call_multipath",
          rubricId: VERDICT_RUBRIC_ID,
          status: "skipped_no_key",
          recordedAt,
          inputs: { candidateKeys: [...allowedKeys] },
          detail:
            "Close-call multipath by code fallback — SERV_API_KEY is not configured (not a SERV multipath call).",
        }),
      ],
    };
  }

  const facts = {
    candidates: candidates.map((c) => ({
      key: c.key,
      label: c.label,
      askUsd: c.askUsd,
      riskScore: c.riskScore,
      totalCostUsd: c.totalCostUsd,
      evidenceIds: c.evidenceIds,
    })),
    allowedKeys: [...allowedKeys],
    allowedEvidenceIds: [...allowedEvidence],
  };

  const judged = await runServ(
    "find_close_call_multipath",
    { user: JSON.stringify({ facts }) },
    {
      fetch: input.fetchImpl ?? fetch,
      apiKey: servKey,
      baseUrl: input.servBaseUrl,
      model: input.model,
      transportPolicy: input.transportPolicy,
    },
  );

  const rawResponse =
    chatCompletionContent(judged.proof?.openserv) ?? (judged.ok ? judged.text : null) ?? null;
  const model = judged.proof?.modelReported ?? judged.proof?.modelRequested ?? input.model ?? null;
  const responseId = providerResponseIdFromCall({
    ok: judged.ok,
    id: typeof judged.proof?.openserv?.id === "string" ? judged.proof.openserv.id : null,
  });

  if (judged.ok && judged.text?.trim()) {
    const parsed = parseAgentMultipathPayload(judged.text, allowedKeys, allowedEvidence);
    if (parsed) {
      const multipath = buildMultipathResultFromServ(parsed, candidates);
      return {
        multipath,
        finalPickKey: multipath.finalPickKey,
        source: "serv",
        proofRecords: [
          buildDecisionProofRecord({
            purpose: "find_close_call_multipath",
            rubricId: VERDICT_RUBRIC_ID,
            status: "ok",
            recordedAt,
            responseId,
            model,
            inputs: {
              candidateKeys: [...allowedKeys],
              finalPickKey: multipath.finalPickKey,
              pathCount: multipath.paths.length,
            },
            verdict: multipath.finalPickKey,
            rawResponse,
            detail: multipath.reconciliation,
          }),
        ],
      };
    }
  }

  const rejectWhy = !judged.ok
    ? judged.failureDiag?.honesty ||
      judged.failureDiag?.reasonCode ||
      judged.error ||
      "SERV find_close_call_multipath did not finish."
    : "SERV close-call multipath payload failed hard allowlist parse — code fallback stands.";

  return {
    multipath: codeFallback,
    finalPickKey: codeFallback?.finalPickKey ?? null,
    source: "code",
    proofRecords: [
      buildDecisionProofRecord({
        purpose: "find_close_call_multipath",
        rubricId: VERDICT_RUBRIC_ID,
        status: "failed",
        recordedAt,
        responseId: null,
        model,
        inputs: { candidateKeys: [...allowedKeys] },
        rawResponse,
        detail: `${rejectWhy} Published close-call paths labelled as code fallback.`,
      }),
    ],
  };
}
