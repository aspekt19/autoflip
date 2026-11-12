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
  type FindDecideIssue,
  type FindDecideShortlistMeta,
  type ValidateFindDecideResult,
} from "@/domain/find-decide";
import { isAwdDrivetrain } from "@/domain/find-car-consistency";
import {
  alignPublishedConfidence,
  cleanLowerMileAlternative,
  type BestDealCandidate,
  type BestDealResult,
} from "@/domain/find-best-deal";
import type { FindFreeGovReceipt } from "@/domain/find-free-gov";
import { needPrefersAwd, type StructuredNeed } from "@/domain/need";
import { extractServJson, tryExtractServJson } from "@/domain/serv-json";
import type { Listing } from "@/domain/types";
import {
  buildDecisionProofRecord,
  VERDICT_RUBRIC_ID,
  type DecisionProofRecord,
} from "@/domain/decision-proof-record";
import { providerResponseId, providerResponseIdFromCall } from "@/domain/serv-response-id";
import {
  buildFindPickComputedReport,
  publishBestDeal,
} from "@/server/find-settle-serv";
import { FIND_DECIDE_MIN_MS } from "@/domain/route-budget";
import {
  chatCompletionContent,
  profile,
  runServ,
  type ServDeps,
  type ServResult,
} from "@/server/serv";
import { callStep, DECIDE_STOP_MESSAGE, SECOND_CHECK_MISSED } from "@/server/serv/call-step";

function receiptEvidenceId(r: FindFreeGovReceipt): string {
  return `${r.checkId}:${r.make}|${r.model}|${r.year}`.toLowerCase();
}

function mapActionToVerdict(action: FindDecideAction): AgentVerdict["verdict"] {
  if (action === "inspect_first") return "needs_inspection";
  return action;
}

/** Never store or show the internal fragment "answer unreadable". */
export function scrubDecideFailureDetail(detail: string | null | undefined): string {
  const text = (detail ?? "").trim();
  if (!text) return "the decision answer could not be read";
  return text
    .replace(/\banswer unreadable\b/gi, "the decision answer could not be read")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function plainDecideFailure(judged: ServResult, issues: FindDecideIssue[]): string {
  if (!judged.ok) {
    if (judged.transportErrorClass === "timeout" || judged.transportErrorClass === "abort") {
      return "timed out before an answer";
    }
    if (judged.httpAttempts === 0) return "timed out before asking";
    if (judged.status === 200) {
      return scrubDecideFailureDetail(judged.error) || "the decision answer could not be read";
    }
    return "the decision service returned an error";
  }
  if (issues.some((issue) => issue.field === "pickKey")) {
    return "blocked by rule: the choice was not one of the cars in this search";
  }
  if (issues.length === 1 && issues[0]?.message) return issues[0].message;
  if (issues.length > 0) return "the decision answer failed validation";
  return "the decision answer could not be read";
}

function logRejectedDecideAnswer(text: string | null | undefined, issues: FindDecideIssue[]): void {
  const sample = (text ?? "").slice(0, 2000);
  console.error(
    `[choose_car] rejected decide answer (${sample.length} chars): ${sample}`,
  );
  console.error(`[choose_car] validation issues: ${JSON.stringify(issues)}`);
}

function parseDecidePayload(
  text: string | null | undefined,
  ctx: {
    shortlistKeys: readonly string[];
    allowedEvidenceIds: ReadonlySet<string>;
    askUsd?: number | null;
    fairValueUsd?: number | null;
    fairValueLowUsd?: number | null;
    fairValueHighUsd?: number | null;
    shortlist?: readonly FindDecideShortlistMeta[];
  },
): { payload: unknown; validated: ValidateFindDecideResult; unparseable: boolean } {
  if (!text?.trim()) {
    return {
      payload: null,
      unparseable: true,
      validated: {
        ok: false,
        issues: [{ field: "decide", message: "the decision answer could not be read" }],
      },
    };
  }
  try {
    const payload = extractServJson(text);
    return {
      payload,
      unparseable: false,
      validated: validateFindDecide(payload, ctx),
    };
  } catch {
    return {
      payload: null,
      unparseable: true,
      validated: {
        ok: false,
        issues: [{ field: "decide", message: "the decision answer could not be read" }],
      },
    };
  }
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
  /** How long this call may wait. The route sets this from the time still left. */
  timeoutMs?: number;
  /** Time left on the route, including this call. A retry runs only when this covers another full wait. */
  remainingMs?: number;
}): Promise<FindDecideServResult> {
  const shortlistKeys = [...input.shortlistKeys];
  const rankedByKey = new Map(
    [...(input.bestDeal.allRanked ?? []), ...input.bestDeal.ranked].map((row) => [row.key, row]),
  );
  const shortlistRows: BestDealCandidate[] = shortlistKeys
    .map((key) => rankedByKey.get(key))
    .filter((row): row is BestDealCandidate => Boolean(row))
    .filter((row) => !row.excludedFromPick);
  const peers =
    shortlistRows.length > 0
      ? shortlistRows
      : input.bestDeal.ranked.filter((row) => !row.excludedFromPick);
  const codePick =
    peers.find((row) => !row.excludedFromPick) ??
    input.bestDeal.pick ??
    peers[0] ??
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
    const accidents =
      typeof row.accidentCount === "number" && Number.isFinite(row.accidentCount)
        ? Math.max(0, Math.floor(row.accidentCount))
        : null;
    const drivetrain = row.drivetrain?.trim() || null;
    return {
      key: row.key,
      year: row.year,
      make: row.make,
      model: row.model,
      askUsd: row.priceUsd,
      miles: row.miles,
      // Explicit drivetrain + accident facts for SERV (including vPIC-filled drivetrain).
      drivetrain,
      drivetrainConfirmedAwd: isAwdDrivetrain(drivetrain),
      drivetrainSource: drivetrain ? "listing_or_vpic" : "unknown",
      fuel: row.fuel ?? null,
      bodyStyle: null,
      accidentCount: accidents,
      accidentCountReported: accidents,
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
        vpicDrivetrain: r.vpicSpecs?.drivetrain ?? null,
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
    "fairValueUsd null/unknown for the pick → confidence at most medium, and say the price comparison is thin. Low only when the second check did not run.",
    "Reasons must say why this pick beats the runner-up with concrete fact differences — do not only restate buyer budget/ZIP/years/must-haves.",
    "offerUsd must be ≤ ask and near code fair value when set.",
    "Published confidence = min(C3, C4 revised, guardrail caps).",
  ];

  const servKey = input.servKey?.trim() || "";
  let decide: FindDecide | null = null;
  let source: "SERV" | "code" = "code";
  let decideModel: string | null = null;
  let decideResponseId: string | null = null;
  let decideFailureDetail: string | null = null;
  const decideTimeoutMs = input.timeoutMs ?? profile("find_decide").timeoutMs;
  const decideUser = JSON.stringify({
    facts: {
      intent: {
        note: input.need.note ?? null,
        budgetUsd: input.need.budgetUsd ?? null,
        yearMin: input.need.yearMin ?? null,
        yearMax: input.need.yearMax ?? null,
        milesMax: input.need.milesMax ?? null,
        mustHaves: input.need.mustHaves ?? [],
        priorities: input.need.priorities ?? [],
        awdPreference: needPrefersAwd({
          awdPreference: input.need.awdPreference,
          note: input.need.note,
          mustHaves: input.need.mustHaves ?? [],
        }),
      },
      shortlist: factSheet,
      shortlistKeys,
      allowedEvidenceIds: [...allowedEvidenceIds],
      codeRankedKey: codePick?.key ?? null,
      guardrailRules: [
        ...guardrailRules,
        "When awdPreference is true, prefer confirmed AWD/4WD (drivetrainConfirmedAwd) over unknown/FWD unless other hard risks dominate.",
        "Use accidentCountReported as a soft risk — do not invent clean history from a zero or null.",
      ],
    },
  });

  const shortlistMeta: FindDecideShortlistMeta[] = peers.map((row) => ({
    key: row.key,
    vin: row.vin ?? null,
    year: row.year,
    make: row.make,
    model: row.model,
  }));

  const decideValidateCtx = (pickRow: BestDealCandidate) => {
    const report = buildFindPickComputedReport(pickRow, peers, input.marketPool ?? []);
    return {
      shortlistKeys,
      allowedEvidenceIds,
      askUsd: pickRow.priceUsd ?? null,
      fairValueUsd: report.fairValueUsd ?? null,
      fairValueLowUsd: report.fairRangeLowUsd ?? null,
      fairValueHighUsd: report.fairRangeHighUsd ?? null,
      shortlist: shortlistMeta,
    };
  };

  const acceptDecideText = (text: string): boolean => {
    try {
      return validateFindDecide(extractServJson(text), {
        shortlistKeys,
        allowedEvidenceIds,
        askUsd: codePick?.priceUsd ?? null,
        shortlist: shortlistMeta,
      }).ok;
    } catch {
      return false;
    }
  };

  if (servKey && codePick && shortlistKeys.length > 0 && decideTimeoutMs >= FIND_DECIDE_MIN_MS) {
    const servDeps: ServDeps = {
      fetch: input.fetchImpl,
      apiKey: servKey,
      baseUrl: input.servBaseUrl,
      model: input.model,
      transportPolicy: input.transportPolicy,
      timeoutMs: decideTimeoutMs,
    };
    const step = await callStep({
      profileId: "find_decide",
      user: decideUser,
      critical: true,
      remainingMs: input.remainingMs ?? decideTimeoutMs,
      accept: acceptDecideText,
      deps: servDeps,
    });
    let judged = step.result;
    let parsed = parseDecidePayload(
      judged.ok ? judged.text : null,
      decideValidateCtx(
        (() => {
          const guess =
            judged.ok && judged.text
              ? (() => {
                  const payload = tryExtractServJson(judged.text);
                  if (
                    payload &&
                    typeof payload === "object" &&
                    !Array.isArray(payload) &&
                    typeof (payload as { pickKey?: unknown }).pickKey === "string"
                  ) {
                    return String((payload as { pickKey: string }).pickKey).trim();
                  }
                  return "";
                })()
              : "";
          return rankedByKey.get(guess) ?? codePick;
        })(),
      ),
    );

    // One validation-error repair call (triage pattern). Real transport failure still stops.
    if (!parsed.validated.ok && judged.ok) {
      logRejectedDecideAnswer(
        judged.text,
        parsed.validated.ok === false ? parsed.validated.issues : [],
      );
      const repair = await runServ(
        "find_decide",
        {
          user: JSON.stringify({
            facts: JSON.parse(decideUser).facts,
            validationError: {
              message: "Previous decide reply failed validation. Fix these issues and return JSON only.",
              issues: parsed.validated.ok === false ? parsed.validated.issues : [],
            },
          }),
        },
        servDeps,
      );
      judged = repair;
      const repairGuess =
        repair.ok && repair.text
          ? (() => {
              const payload = tryExtractServJson(repair.text);
              if (
                payload &&
                typeof payload === "object" &&
                !Array.isArray(payload) &&
                typeof (payload as { pickKey?: unknown }).pickKey === "string"
              ) {
                return String((payload as { pickKey: string }).pickKey).trim();
              }
              return "";
            })()
          : "";
      parsed = parseDecidePayload(
        repair.ok ? repair.text : null,
        decideValidateCtx(rankedByKey.get(repairGuess) ?? codePick),
      );
    }

    const revalidated = parsed.validated;
    const rawResponse =
      chatCompletionContent(judged.proof?.openserv) ?? (judged.ok ? judged.text : null) ?? null;
    decideModel = judged.proof?.modelReported ?? judged.proof?.modelRequested ?? input.model ?? null;
    const providerId =
      typeof judged.proof?.openserv?.id === "string" ? judged.proof.openserv.id : null;
    decideResponseId = providerResponseIdFromCall({
      ok: judged.ok && revalidated.ok,
      id: providerId,
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
      const issues = revalidated.ok === false ? revalidated.issues : [];
      logRejectedDecideAnswer(judged.ok ? judged.text : null, issues);
      decideFailureDetail = scrubDecideFailureDetail(plainDecideFailure(judged, issues));
      console.error(`[choose_car] ${decideFailureDetail}`);
      const failedId = providerResponseId(providerId);
      proofRecords.push(
        buildDecisionProofRecord({
          purpose: "find_decide",
          rubricId: VERDICT_RUBRIC_ID,
          status: "failed",
          recordedAt,
          responseId: failedId,
          model: decideModel,
          inputs: {
            shortlistKeys,
            issues,
          },
          detail: decideFailureDetail,
          rawResponse,
        }),
      );
      // Stopped / unreadable decide is not a decision. Do not publish a code verdict.
      if (!judged.ok || step.status === "stopped" || parsed.unparseable) {
        return {
          bestDeal: input.bestDeal,
          decide: {
            pickKey: "",
            action: "pass",
            confidence: "low",
            confidenceWhy: decideFailureDetail,
            reasons: [],
            watchOuts: [],
            askSeller: [],
            alternatives: [],
            offerUsd: null,
          },
          source: "code",
          agentVerdict: {
            schemaVersion: "lemonless.agent_verdict.v1",
            verdict: null,
            confidence: "low",
            pick: null,
            reasons: [],
            risks: [],
            unknowns: [DECIDE_STOP_MESSAGE],
            serv_steps: [],
            no_serv_step: true,
            second_pass: emptySecondPass(decideFailureDetail),
            multipath: null,
            vs_cheapest: null,
            serv_spend: null,
          },
          secondPass: emptySecondPass(decideFailureDetail, "unavailable"),
          proofRecords,
        };
      }
    }
  } else {
    decideFailureDetail = !servKey
      ? null
      : !codePick || shortlistKeys.length === 0
        ? "there was no shortlist to decide"
        : "timed out before asking";
    if (servKey) console.error(`[choose_car] ${decideFailureDetail}`);
    proofRecords.push(
      buildDecisionProofRecord({
        purpose: "find_decide",
        rubricId: VERDICT_RUBRIC_ID,
        status: servKey ? "failed" : "skipped_no_key",
        recordedAt,
        inputs: { shortlistKeys },
        detail: servKey
          ? decideFailureDetail ?? "timed out before asking"
          : "SERV_API_KEY not configured — code pick.",
      }),
    );
  }

  if (!decide && codePick) {
    decide = {
      pickKey: codePick.key,
      action: "negotiate",
      confidence: "low",
      confidenceWhy: "SERV did not decide this one.",
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
        verdict: null,
        confidence: "low",
        pick: null,
        reasons: [],
        risks: [],
        unknowns: [
          servKey && codePick
            ? "Our AI couldn't finish this decision; no credit used."
            : "No cars matched. Nothing was charged for a verdict.",
        ],
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
    const challengeStep = await callStep({
      profileId: "find_challenge",
      critical: false,
      user: JSON.stringify({
        facts: {
          shortlist: factSheet,
          shortlistKeys,
          allowedEvidenceIds: [...allowedEvidenceIds],
          decide,
          guardrailRules,
        },
      }),
      deps: {
        fetch: input.fetchImpl,
        apiKey: servKey,
        baseUrl: input.servBaseUrl,
        model: input.model,
        transportPolicy: input.transportPolicy,
        timeoutMs: profile("find_challenge").timeoutMs,
      },
    });
    const challenged = challengeStep.result;
    if (challengeStep.degraded) {
      decide = { ...decide, confidence: "low" };
    }
    let payload: unknown = null;
    if (challenged.ok && challenged.text?.trim()) {
      payload = tryExtractServJson(challenged.text);
    }
    const validated = validateFindChallenge(payload, {
      shortlistKeys,
      allowedEvidenceIds,
      shortlist: shortlistMeta,
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
      decide = { ...decide, confidence: "low" };
      secondPass = emptySecondPass(SECOND_CHECK_MISSED, "unavailable");
      proofRecords.push(
        buildDecisionProofRecord({
          purpose: "find_challenge",
          rubricId: VERDICT_RUBRIC_ID,
          status: "failed",
          recordedAt,
          responseId: null,
          model: challengeModel,
          inputs: { issues: validated.ok === false ? validated.issues : [] },
          detail: SECOND_CHECK_MISSED,
          rawResponse,
        }),
      );
    }
  }

  if (secondPass.status !== "agreed" && secondPass.status !== "disagreed" && decide.confidence !== "low") {
    decide = {
      ...decide,
      confidence: "low",
      confidenceWhy: "A second check did not run, so confidence is Low.",
    };
  }

  const chosen = rankedByKey.get(decide.pickKey) ?? codePick;
  const safer = cleanLowerMileAlternative(chosen, peers);
  const pick = safer ?? chosen;
  if (safer && decide.pickKey !== safer.key) {
    decide = {
      ...decide,
      pickKey: safer.key,
      confidenceWhy: "A car with fewer miles and no reported accident outranks the one with a reported accident.",
    };
  }
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
    fairValueUsd: pickReport.fairValueUsd ?? null,
    evidenceSettled: true,
    secondCheckMissed: secondPass.status !== "agreed" && secondPass.status !== "disagreed",
  });
  decide = { ...decide, confidence: published.confidence, action: published.action };

  const publishedBestDeal = alignPublishedConfidence(
    publishBestDeal({
      bestDeal: {
        ...input.bestDeal,
        evidenceSettled: true,
        settlementNote: "Public checks and the decision are finished.",
      },
      pick,
      confidence: published.confidence,
      actor: source,
      servNote: decide.confidenceWhy,
      confidenceCapReason: published.reasons.at(-1) ?? null,
    }),
    published.confidence,
    published.reasons.at(-1) ?? decide.confidenceWhy,
  );

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
            : "SERV did not decide this one.",
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
