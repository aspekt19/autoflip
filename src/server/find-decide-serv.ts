/**
 * C3 find_decide + C4 find_challenge SERV runner.
 * Published confidence = min(C3, C4, guardrails). Code pick fallback when C3 fails.
 */
import type {
  AgentSecondPassResult,
  AgentVerdict,
  AgentVerdictConfidence,
} from "@/domain/agent-verdict-schema";
import {
  applyFindChallengeRevision,
  publishFindDecideConfidence,
  validateFindChallenge,
  validateFindDecide,
  type FindDecide,
  type FindDecideAction,
  type FindDecideConfidence,
} from "@/domain/find-decide";
import type { BestDealCandidate, BestDealResult } from "@/domain/find-best-deal";
import type { FindFreeGovReceipt } from "@/domain/find-free-gov";
import type { StructuredNeed } from "@/domain/need";
import type { Listing } from "@/domain/types";
import {
  buildDecisionProofRecord,
  VERDICT_RUBRIC_ID,
  type DecisionProofRecord,
} from "@/domain/decision-proof-record";
import { providerResponseIdFromCall } from "@/domain/serv-response-id";
import {
  buildFindPickComputedReport,
  publishBestDeal,
} from "@/server/find-settle-serv";
import { chatCompletionContent, profile, runServ, type ServDeps } from "@/server/serv";

function receiptEvidenceId(r: FindFreeGovReceipt): string {
  return `${r.checkId}:${r.make}|${r.model}|${r.year}`.toLowerCase();
}

function mapActionToVerdict(action: FindDecideAction): AgentVerdict["verdict"] {
  if (action === "inspect_first") return "needs_inspection";
  return action;
}

function emptySecondPass(
  objection: string,
  status: AgentSecondPassResult["status"] = "not_run",
): AgentSecondPassResult {
  return {
    status,
    action: null,
    objection,
    evidenceIds: [],
    confidenceBefore: null,
    confidenceAfter: null,
  };
}

export type FindDecideServResult = {
  bestDeal: BestDealResult;
  decide: FindDecide;
  source: "SERV" | "code";
  agentVerdict: AgentVerdict;
  secondPass: AgentSecondPassResult;
  proofRecords: DecisionProofRecord[];
};

export async function runFindDecideServ(input: {
  need: StructuredNeed;
  bestDeal: BestDealResult;
  shortlistKeys: readonly string[];
  receipts: readonly FindFreeGovReceipt[];
  marketPool?: readonly Listing[];
  servKey?: string | null;
  servBaseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  transportPolicy?: ServDeps["transportPolicy"];
}): Promise<FindDecideServResult> {
  const shortlistKeys = [...input.shortlistKeys];
  const rankedByKey = new Map(input.bestDeal.ranked.map((row) => [row.key, row]));
  const shortlistRows: BestDealCandidate[] = shortlistKeys
    .map((key) => rankedByKey.get(key))
    .filter((row): row is BestDealCandidate => Boolean(row));
  const peers = shortlistRows.length > 0 ? shortlistRows : input.bestDeal.ranked;
  const codePick =
    shortlistRows.find((row) => !row.excludedFromPick) ??
    input.bestDeal.pick ??
    input.bestDeal.ranked[0] ??
    null;

  const recordedAt = new Date().toISOString();
  const proofRecords: DecisionProofRecord[] = [];
  const allowedEvidenceIds = new Set<string>();
  for (const row of peers) {
    allowedEvidenceIds.add(`car:${row.key}`);
    if (typeof row.priceUsd === "number") allowedEvidenceIds.add(`ask:${row.key}`);
    allowedEvidenceIds.add(`fair:${row.key}`);
    allowedEvidenceIds.add(`comps:${row.key}`);
  }
  for (const r of input.receipts) allowedEvidenceIds.add(receiptEvidenceId(r));

  const factSheet = peers.map((row) => {
    const report = buildFindPickComputedReport(row, peers, input.marketPool ?? []);
    const mmyReceipts = input.receipts.filter(
      (r) =>
        r.make.toLowerCase() === row.make.toLowerCase() &&
        r.model.toLowerCase() === row.model.toLowerCase() &&
        r.year === row.year,
    );
    return {
      key: row.key,
      year: row.year,
      make: row.make,
      model: row.model,
      askUsd: row.priceUsd,
      miles: row.miles,
      drivetrain: row.drivetrain ?? null,
      fuel: row.fuel ?? null,
      bodyStyle: row.bodyStyle ?? null,
      accidentCount: row.accidentCount ?? null,
      cpo: row.cpo ?? null,
      ownerCount: row.ownerCount ?? null,
      fairValueUsd: report.fairValueUsd,
      fairRangeLowUsd: report.fairRangeLowUsd,
      fairRangeHighUsd: report.fairRangeHighUsd,
      compCount: report.compSampleSize ?? report.comps.length,
      recallsAvailable: report.recallsAvailable,
      openParkIt: report.openParkIt,
      openParkOutside: report.openParkOutside,
      score: row.score,
      factors: row.factors.slice(0, 8).map((f) => ({ id: f.id, detail: f.detail, points: f.points })),
      freeGov: mmyReceipts.map((r) => ({
        evidenceId: receiptEvidenceId(r),
        checkId: r.checkId,
        status: r.status,
        summary: r.summary,
        riskFacts: r.riskFacts,
        fuelEvidence: r.fuelEvidence,
      })),
      evidenceIds: [
        `car:${row.key}`,
        ...(typeof row.priceUsd === "number" ? [`ask:${row.key}`] : []),
        `fair:${row.key}`,
        `comps:${row.key}`,
        ...mmyReceipts.map(receiptEvidenceId),
      ],
    };
  });

  const guardrailRules = [
    "Stop-level park-it/park-outside → action ≤ inspect_first and confidence ≤ medium.",
    "Recall data unavailable for the pick → confidence ≤ medium.",
    "Fewer than 3 comps → confidence ≤ medium; word price as limited comparison.",
    "offerUsd must be ≤ ask and near code fair value when set.",
    "Published confidence = min(C3, C4 revised, guardrail caps).",
  ];

  const servKey = input.servKey?.trim() || "";
  let decide: FindDecide | null = null;
  let source: "SERV" | "code" = "code";
  let decideModel: string | null = null;
  let decideResponseId: string | null = null;

  if (servKey && codePick && shortlistKeys.length > 0) {
    const judged = await runServ(
      "find_decide",
      {
        user: JSON.stringify({
          facts: {
            intent: {
              note: input.need.note ?? null,
              budgetUsd: input.need.budgetUsd ?? null,
              yearMin: input.need.yearMin ?? null,
              yearMax: input.need.yearMax ?? null,
              milesMax: input.need.milesMax ?? null,
              mustHaves: input.need.mustHaves ?? [],
              priorities: input.need.priorities ?? [],
            },
            shortlist: factSheet,
            shortlistKeys,
            allowedEvidenceIds: [...allowedEvidenceIds],
            codeRankedKey: codePick.key,
            guardrailRules,
          },
        }),
      },
      {
        fetch: input.fetchImpl,
        apiKey: servKey,
        baseUrl: input.servBaseUrl,
        model: input.model,
        transportPolicy: input.transportPolicy,
        timeoutMs: profile("find_decide").timeoutMs,
      },
    );
    let payload: unknown = null;
    if (judged.ok && judged.text?.trim()) {
      try {
        payload = JSON.parse(judged.text);
      } catch {
        payload = null;
      }
    }
    const pickKeyGuess =
      payload && typeof payload === "object" && !Array.isArray(payload) && typeof (payload as { pickKey?: unknown }).pickKey === "string"
        ? String((payload as { pickKey: string }).pickKey).trim()
        : "";
    const servPickRow = rankedByKey.get(pickKeyGuess) ?? codePick;
    const servPickReport = buildFindPickComputedReport(servPickRow, peers, input.marketPool ?? []);
    const revalidated = validateFindDecide(payload, {
      shortlistKeys,
      allowedEvidenceIds,
      askUsd: servPickRow.priceUsd ?? null,
      fairValueUsd: servPickReport.fairValueUsd ?? null,
      fairValueLowUsd: servPickReport.fairRangeLowUsd ?? null,
      fairValueHighUsd: servPickReport.fairRangeHighUsd ?? null,
    });
    const rawResponse =
      chatCompletionContent(judged.proof?.openserv) ?? (judged.ok ? judged.text : null) ?? null;
    decideModel = judged.proof?.modelReported ?? judged.proof?.modelRequested ?? input.model ?? null;
    decideResponseId = providerResponseIdFromCall({
      ok: judged.ok && revalidated.ok,
      id: typeof judged.proof?.openserv?.id === "string" ? judged.proof.openserv.id : null,
    });
    if (revalidated.ok) {
      decide = revalidated.decide;
      source = "SERV";
      proofRecords.push(
        buildDecisionProofRecord({
          purpose: "find_decide",
          rubricId: VERDICT_RUBRIC_ID,
          status: "ok",
          recordedAt,
          responseId: decideResponseId,
          model: decideModel,
          inputs: {
            shortlistKeys,
            pickKey: decide.pickKey,
            dropped: revalidated.dropped,
          },
          verdict: decide.action,
          detail: decide.confidenceWhy,
          rawResponse,
        }),
      );
    } else {
      proofRecords.push(
        buildDecisionProofRecord({
          purpose: "find_decide",
          rubricId: VERDICT_RUBRIC_ID,
          status: "failed",
          recordedAt,
          responseId: null,
          model: decideModel,
          inputs: {
            shortlistKeys,
            issues: revalidated.ok === false ? revalidated.issues : [],
          },
          detail: "SERV decide failed validation — code pick published (confidence ≤ medium).",
          rawResponse,
        }),
      );
    }
  } else {
    proofRecords.push(
      buildDecisionProofRecord({
        purpose: "find_decide",
        rubricId: VERDICT_RUBRIC_ID,
        status: servKey ? "failed" : "skipped_no_key",
        recordedAt,
        inputs: { shortlistKeys },
        detail: servKey
          ? "No shortlist pick available — code fallback."
          : "SERV_API_KEY not configured — code pick.",
      }),
    );
  }

  if (!decide && codePick) {
    decide = {
      pickKey: codePick.key,
      action: "negotiate",
      confidence: "medium",
      confidenceWhy: "AI review unavailable — code ranking stands.",
      reasons: [
        {
          text: codePick.factors[0]?.detail || "Leading on the code score among the shortlist.",
          evidenceIds: [`car:${codePick.key}`],
        },
      ],
      watchOuts: [],
      askSeller: codePick.sellerQuestions.slice(0, 4),
      alternatives: shortlistRows
        .filter((row) => row.key !== codePick.key)
        .slice(0, 3)
        .map((row) => ({ key: row.key, whyNot: "Not the code ranking leader." })),
      offerUsd: null,
    };
    source = "code";
  }

  if (!decide || !codePick) {
    // Empty inventory — return the input bestDeal unchanged.
    return {
      bestDeal: input.bestDeal,
      decide: {
        pickKey: "",
        action: "pass",
        confidence: "low",
        confidenceWhy: "No cars to decide among.",
        reasons: [],
        watchOuts: [],
        askSeller: [],
        alternatives: [],
        offerUsd: null,
      },
      source: "code",
      agentVerdict: {
        schemaVersion: "lemonless.agent_verdict.v1",
        verdict: "pass",
        confidence: "low",
        pick: null,
        reasons: [],
        risks: [],
        unknowns: ["No cars to decide among."],
        serv_steps: [],
        no_serv_step: true,
        second_pass: emptySecondPass("No cars to decide among."),
        multipath: null,
        vs_cheapest: null,
        serv_spend: null,
      },
      secondPass: emptySecondPass("No cars to decide among."),
      proofRecords,
    };
  }

  // C4 challenge
  let challengeAgree = true;
  let secondPass: AgentSecondPassResult = emptySecondPass(
    servKey ? "Second review not required yet." : "Second check not run: SERV_API_KEY not configured.",
    servKey ? "not_run" : "skipped_no_key",
  );
  let revisedConfidence: FindDecideConfidence | null = null;

  if (servKey && source === "SERV") {
    const challenged = await runServ(
      "find_challenge",
      {
        user: JSON.stringify({
          facts: {
            shortlist: factSheet,
            shortlistKeys,
            allowedEvidenceIds: [...allowedEvidenceIds],
            decide,
            guardrailRules,
          },
        }),
      },
      {
        fetch: input.fetchImpl,
        apiKey: servKey,
        baseUrl: input.servBaseUrl,
        model: input.model,
        transportPolicy: input.transportPolicy,
        timeoutMs: profile("find_challenge").timeoutMs,
      },
    );
    let payload: unknown = null;
    if (challenged.ok && challenged.text?.trim()) {
      try {
        payload = JSON.parse(challenged.text);
      } catch {
        payload = null;
      }
    }
    const validated = validateFindChallenge(payload, {
      shortlistKeys,
      allowedEvidenceIds,
    });
    const rawResponse =
      chatCompletionContent(challenged.proof?.openserv) ??
      (challenged.ok ? challenged.text : null) ??
      null;
    const challengeModel =
      challenged.proof?.modelReported ?? challenged.proof?.modelRequested ?? input.model ?? null;
    const challengeResponseId = providerResponseIdFromCall({
      ok: challenged.ok && validated.ok,
      id: typeof challenged.proof?.openserv?.id === "string" ? challenged.proof.openserv.id : null,
    });
    if (validated.ok) {
      decide = applyFindChallengeRevision(decide, validated.challenge);
      challengeAgree = validated.challenge.agree;
      revisedConfidence = validated.challenge.revised.confidence;
      secondPass = {
        status: validated.challenge.agree ? "agreed" : "disagreed",
        action: mapActionToVerdict(decide.action) as AgentSecondPassResult["action"],
        objection: validated.challenge.agree
          ? "Second review agreed with the pick."
          : validated.challenge.issues[0]?.text || "Second review revised the pick.",
        evidenceIds: validated.challenge.issues.flatMap((issue) => issue.evidenceIds).slice(0, 8),
        confidenceBefore: decide.confidence as AgentVerdictConfidence,
        confidenceAfter: decide.confidence as AgentVerdictConfidence,
      };
      proofRecords.push(
        buildDecisionProofRecord({
          purpose: "find_challenge",
          rubricId: VERDICT_RUBRIC_ID,
          status: "ok",
          recordedAt,
          responseId: challengeResponseId,
          model: challengeModel,
          inputs: {
            agree: validated.challenge.agree,
            dropped: validated.dropped,
          },
          verdict: decide.action,
          detail: secondPass.objection ?? "",
          rawResponse,
        }),
      );
    } else {
      // C4 fail → publish C3 with confidence capped at medium.
      if (decide.confidence === "high") decide = { ...decide, confidence: "medium" };
      secondPass = emptySecondPass("Second review unavailable — confidence capped at medium.", "unavailable");
      proofRecords.push(
        buildDecisionProofRecord({
          purpose: "find_challenge",
          rubricId: VERDICT_RUBRIC_ID,
          status: "failed",
          recordedAt,
          responseId: null,
          model: challengeModel,
          inputs: { issues: validated.ok === false ? validated.issues : [] },
          detail: "Second review unavailable — confidence capped at medium.",
          rawResponse,
        }),
      );
    }
  }

  const pick = rankedByKey.get(decide.pickKey) ?? codePick;
  const pickReport = buildFindPickComputedReport(pick, peers, input.marketPool ?? []);
  const hasStop = Boolean(pickReport.openParkIt || pickReport.openParkOutside);
  const recallsUnavailable = !pickReport.recallsAvailable;
  const published = publishFindDecideConfidence({
    c3: decide.confidence,
    c4Revised: challengeAgree ? null : revisedConfidence,
    action: decide.action,
    hasStopRecall: hasStop,
    recallsUnavailable,
    compCount: pickReport.compSampleSize ?? pickReport.comps.length,
    evidenceSettled: true,
  });
  decide = { ...decide, confidence: published.confidence, action: published.action };

  const publishedBestDeal = publishBestDeal({
    bestDeal: {
      ...input.bestDeal,
      evidenceSettled: true,
      settlementNote: "Free public checks and SERV decide finished for this Find.",
    },
    pick,
    confidence: published.confidence,
    actor: source,
    servNote: decide.confidenceWhy,
    confidenceCapReason: published.capped ? published.reasons[0] ?? null : null,
  });

  const pickLabel = `${pick.year} ${pick.make} ${pick.model}`;
  const agentVerdict: AgentVerdict = {
    schemaVersion: "lemonless.agent_verdict.v1",
    verdict: mapActionToVerdict(decide.action),
    confidence: decide.confidence,
    pick: { key: pick.key, label: pickLabel },
    reasons: decide.reasons.map((line) => ({
      evidenceId: line.evidenceIds[0] ?? `car:${pick.key}`,
      text: line.text,
    })),
    risks: decide.watchOuts.map((line) => ({
      evidenceId: line.evidenceIds[0] ?? `car:${pick.key}`,
      text: line.text,
    })),
    unknowns: decide.askSeller.slice(0, 4),
    serv_steps: [
      {
        decided:
          source === "SERV"
            ? `SERV picked ${pickLabel}.`
            : `Code picked ${pickLabel} (AI review unavailable).`,
        why: decide.confidenceWhy,
        changed: null,
        model: decideModel,
        responseId: decideResponseId,
        recordedAt,
      },
      ...(published.capped
        ? [
            {
              decided: published.reasons[0] ?? "Confidence capped by guardrails.",
              why: "Published confidence = min(C3, C4, guardrail caps).",
              changed: "Published confidence adjusted.",
              model: decideModel,
              responseId: decideResponseId,
              recordedAt,
            },
          ]
        : []),
    ],
    no_serv_step: source !== "SERV",
    second_pass: secondPass,
    multipath: null,
    vs_cheapest: null,
    serv_spend: null,
  };

  return {
    bestDeal: publishedBestDeal,
    decide,
    source,
    agentVerdict,
    secondPass,
    proofRecords,
  };
}
