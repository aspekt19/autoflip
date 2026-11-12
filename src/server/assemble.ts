import { randomUUID } from "node:crypto";
import { auditExplanation } from "@/domain/audit";
import { quotedNumbersStayIn } from "@/domain/decision-note";
import { haversineMiles } from "@/domain/geo";
import { sha256Canonical } from "@/domain/hash";
import { coverageConfidence, coverageSentence } from "@/domain/coverage";
import { priceBadge } from "@/domain/price-badge";
import { buildComputedReport } from "@/domain/report";
import { resolvePurchaseAskForEconomics } from "@/domain/report-purchase-ask";
import { screenUserInput } from "@/domain/screen";
import { passengerBodyStyleParam } from "@/domain/passenger-vehicle";
import { providerYearQuery } from "@/domain/search-spec";
import { templateExplanation } from "@/domain/template";
import { buildAgentVerdictFromReport } from "@/domain/agent-trail";
import { collectReportEvidenceIds, runReportVerdictChallenge } from "@/server/agent-second-pass";
import { resolveVerdictDecision, verdictDecisionFacts } from "@/domain/verdict-decide";
import { extractVin } from "@/domain/vin";
import type { FullReport, Listing, Mode, Proof, ProofStep } from "@/domain/types";
import { autodevByVin, autodevSearch, type AutodevDeps } from "@/io/autodev";
import { postFilterFlipInventory, resaleMilesCap } from "@/domain/resale-sanity";
import {
  geoScopeFromSearch,
  geoScopeLabel,
  readComps,
  rememberComps,
  type CompGeoScope,
} from "@/io/comp-cache";
import { getKv, type Kv } from "@/io/kv";
import { isServerlessRuntime, requireSharedQuotaForPaidDispatch } from "@/server/paid-dispatch-guard";
import { complaintCountFor, decodeVin, fuelFor, geocodeZipCity, recallsFor, type GovDeps } from "@/io/gov";
import {
  EXPLAIN_PROMPT_VERSION,
  GUARD_PROMPT_VERSION,
  SHADOW_HINT,
  SHADOW_MAX_ITERATIONS,
} from "@/io/serv";
import { agentProof, interpretGuard, plannedProof, runServ, type AgentProof, type ProfileId, type ServProof } from "@/server/serv";
import type { AgentVerdictConfidence } from "@/domain/agent-verdict-schema";
import type { DecisionAction } from "@/domain/decision-action";

export type AssembleInput = {
  mode: Mode;
  vin?: string;
  url?: string;
  make?: string;
  model?: string;
  zip?: string;
  year?: number;
  /** Typed by the shopper when the lookup is a VIN, which has no asking price of its own. */
  askingPriceUsd?: number;
  miles?: number;
  /**
   * Where ask/miles overlays came from. Trusted /find handoff uses `find_feed`
   * so report provenance must not claim the shopper typed feed facts.
   * Default `typed` preserves manual Check-a-car / VIN-only wording.
   */
  factSource?: "typed" | "find_feed";
  repairAbility?: import("@/domain/need").RepairAbility;
  targetProfitUsd?: number | null;
  /** Personal-mode budget from /find when the shopper stated one. */
  budgetUsd?: number | null;
  budgetKnown?: boolean;
};

export type AssembleDeps = {
  autodevKey?: string;
  servKey?: string;
  servModel?: string;
  servBaseUrl?: string;
  /** Which guard and explain profiles to use. Report, /check, and the agent API are separate profiles. */
  servSurface?: "report" | "check" | "agent";
  fetch?: typeof fetch;
  /**
   * Autodev deps. `reserve` must be the persistent shared monthly ledger (reserveTotalCall)
   * in production — not only an in-memory counter. Cache hits skip reserve inside autodevSearch.
   */
  autodev?: Pick<AutodevDeps, "cache" | "counter" | "reserve" | "signal" | "timeoutMs">;
  now?: Date;
  /** When set (e.g. /find), use this Kv for shared-store gate instead of process getKv(). */
  kv?: Kv;
  env?: Record<string, string | undefined>;
};

export type AssembleResult =
  | { ok: true; report: FullReport }
  | { ok: false; status: number; error: string; message: string };

function overlayStatedFacts(subject: Listing, input: AssembleInput): {
  listing: Listing;
  purchaseAskNote: string | null;
  statedAskApplied: boolean;
} {
  const milesOverlay =
    typeof input.miles === "number" && input.miles >= 0 ? { miles: input.miles } : {};
  const statedAsk =
    typeof input.askingPriceUsd === "number" && input.askingPriceUsd > 0
      ? input.askingPriceUsd
      : undefined;
  const resolved = resolvePurchaseAskForEconomics(
    { ...subject, ...milesOverlay },
    statedAsk !== undefined ? { statedAskingPriceUsd: statedAsk } : undefined,
  );
  return {
    listing: resolved.listing,
    purchaseAskNote: resolved.dataNote,
    statedAskApplied: statedAsk !== undefined && resolved.usableForEconomics,
  };
}

function factsOf(report: FullReport["computed"]) {
  return {
    verdict: report.verdict,
    mode: report.mode,
    sample: report.sample,
    subject: {
      vin: report.subject.vin,
      year: report.subject.year,
      make: report.subject.make,
      model: report.subject.model,
      trim: report.subject.trim,
      miles: report.subject.miles,
      priceUsd: report.subject.priceUsd,
      city: report.subject.city,
      state: report.subject.state,
      accidentCount: report.subject.accidentCount,
      ownerCount: report.subject.ownerCount,
      oneOwner: report.subject.oneOwner,
      usageType: report.subject.usageType,
      cpo: report.subject.cpo,
    },
    fairValueUsd: report.fairValueUsd,
    priceGap: report.priceGap,
    percentile: report.percentile,
    compCount: report.comps.length,
    comps: report.comps.map((comp) => ({
      vin: comp.vin,
      priceUsd: comp.priceUsd,
      adjustedPriceUsd: comp.adjustedPriceUsd,
      miles: comp.miles,
    })),
    reasons: report.reasons,
    dataNotes: report.dataNotes,
    recallsAvailable: report.recallsAvailable,
    recalls: report.recalls.map((recall) => ({
      campaignNumber: recall.campaignNumber,
      component: recall.component,
      parkIt: recall.parkIt,
      parkOutSide: recall.parkOutSide,
    })),
    complaintCount: report.complaintCount,
    fuel: report.fuel,
    flip: report.flip,
    historyLines: report.history.lines,
  };
}

export async function assembleReport(input: AssembleInput, deps: AssembleDeps): Promise<AssembleResult> {
  const steps: ProofStep[] = [];
  const lookupText = [input.url, input.vin, input.make, input.model, input.zip, input.year?.toString()]
    .filter(Boolean)
    .join(" ");
  const screened = screenUserInput(lookupText || "");
  if (!screened.ok) {
    return { ok: false, status: 400, error: "rejected_input", message: screened.reason };
  }
  steps.push({ id: "local_input_screen", status: "passed" });

  const vin = extractVin(input.vin || input.url || "");
  if (!vin) {
    return {
      ok: false,
      status: 400,
      error: "vin_required",
      message: "A full report needs one vehicle. Paste a listing URL that contains a VIN, or choose a car from Deal Radar.",
    };
  }

  const fetchImpl = deps.fetch ?? fetch;
  const model = deps.servModel || process.env.SERV_MODEL;
  const guardProfile: ProfileId = deps.servSurface === "check" ? "check_guard" : deps.servSurface === "agent" ? "agent_guard" : "report_guard";
  const explainProfile: ProfileId = deps.servSurface === "agent" ? "agent_explain" : "report_explain";

  let guardProof: ServProof | null = null;
  if (!deps.servKey) {
    steps.push({
      id: "serv_prompt_guard",
      status: "skipped",
      detail: "SERV_API_KEY is not set. The local screen still ran. The written summary is the template.",
    });
  } else {
    const guard = await runServ(guardProfile, { user: screened.text }, {
      fetch: fetchImpl,
      apiKey: deps.servKey,
      baseUrl: deps.servBaseUrl,
      model,
    });
    guardProof = guard.proof;
    if (!guard.ok) {
      steps.push({ id: "serv_prompt_guard", status: "error", detail: guard.error });
      return {
        ok: false,
        status: 503,
        error: "serv_unavailable",
        message: "We couldn't finish reading that request. Try again in a moment.",
      };
    }
    const decision = interpretGuard(guard.text);
    steps.push({ id: "serv_prompt_guard", status: decision, detail: GUARD_PROMPT_VERSION });
    if (decision === "block") {
      return {
        ok: false,
        status: 400,
        error: "rejected_input",
        message: "We couldn't read that as a car request. Try describing the car, budget and ZIP.",
      };
    }
  }

  const resolved = await resolveSubject(vin, input, deps, fetchImpl);
  if (!resolved.ok) return resolved.result;
  steps.push({
    id: "listings",
    status: resolved.sample ? "sample" : "autodev",
    detail: resolved.cached ? "cache hit" : "fetched",
  });

  const gov: GovDeps = { fetch: fetchImpl };
  const [vinDecode, recallLookup, complaintCount, fuel, distance] = await Promise.all([
    decodeVin(vin, gov),
    recallsFor(resolved.subject.make, resolved.subject.model, resolved.subject.year, gov),
    complaintCountFor(resolved.subject.make, resolved.subject.model, resolved.subject.year, gov),
    fuelFor(resolved.subject.year, resolved.subject.make, resolved.subject.model, resolved.subject.engine, gov),
    distanceBetween(resolved.subject, input.zip, gov),
  ]);
  steps.push({
    id: "government_data",
    status: "ran",
    detail: "NHTSA vPIC, NHTSA recalls, NHTSA complaints, fueleconomy.gov, US Census geocoder",
  });

  const overlaid = overlayStatedFacts(resolved.subject, input);
  const subject = overlaid.listing;
  const checkedAt = (deps.now ?? new Date()).toISOString();
  const computed = buildComputedReport({
    mode: input.mode,
    subject,
    candidates: resolved.candidates,
    recalls: recallLookup.records,
    recallsAvailable: recallLookup.available,
    complaintCount,
    fuel,
    vinDecode,
    distanceToSearchZipMiles: distance,
    checkedAt,
    listingCached: resolved.cached,
    externalLookupsPerformed: true,
    distanceRequested: Boolean(input.zip && subject.zip),
    asOfYear: (deps.now ?? new Date()).getUTCFullYear(),
    sample: resolved.sample,
    repairAbility: input.repairAbility,
    targetProfitUsd: input.targetProfitUsd,
  });
  if (overlaid.purchaseAskNote) {
    computed.dataNotes.push(overlaid.purchaseAskNote);
  }
  const fromFindFeed = input.factSource === "find_feed";
  if (overlaid.statedAskApplied) {
    computed.dataNotes.push(
      fromFindFeed
        ? "Asking price came from the seller listing feed selected on Find — not a verified sold or out-the-door price."
        : "Asking price was typed in for this VIN. It did not come from a listing feed.",
    );
  }
  if (typeof input.miles === "number") {
    computed.dataNotes.push(
      fromFindFeed
        ? "Mileage came from the seller listing feed selected on Find."
        : "Mileage was typed in for this VIN. It did not come from a listing feed.",
    );
  }
  steps.push({
    id: "deterministic_tools",
    status: "ran",
    detail:
      "evaluateListingPrice, adjustComparableSet, historyAdjustment, verdictFromPriceGap, flipMath, scoreFromGap, dealerQuestions",
  });

  const mandate = {
    budgetUsd: input.budgetUsd ?? null,
    budgetKnown: input.budgetKnown === true,
    targetProfitUsd: input.targetProfitUsd ?? null,
    repairAbility: input.repairAbility ?? "unknown",
  };
  computed.mandate = mandate;
  // Stamp comparable provenance for the report UI.
  computed.comps = computed.comps.map((comp) => ({
    ...comp,
    sourceLabel: computed.sample ? "Labeled sample fixture" : "Auto.dev listing",
    fetchedAt: checkedAt,
  }));

  // Ordered gates first. WITHHELD skips the SERV verdict call.
  const previewDecision = resolveVerdictDecision({
    report: computed,
    servText: null,
    servOk: false,
    hasServKey: false,
    mandate,
  });
  steps.push({
    id: "ordered_gates",
    status: previewDecision.gateRun.withheld ? "withheld" : "passed",
    detail: previewDecision.gateRun.gates.map((gate) => `${gate.id}:${gate.status}`).join(", "),
  });

  let verdictServText: string | null = null;
  let verdictServOk = false;
  let verdictServProof: ServProof | null = null;
  if (previewDecision.gateRun.withheld) {
    steps.push({
      id: "serv_verdict_decide",
      status: "skipped_withheld",
      detail: previewDecision.withholdReason ?? "Verdict withheld by ordered gates.",
    });
  } else if (deps.servKey) {
    const decisionFacts = verdictDecisionFacts(computed, mandate);
    const judged = await runServ(
      "verdict_decide",
      { user: JSON.stringify({ facts: decisionFacts, userLookup: screened.text }) },
      {
        fetch: fetchImpl,
        apiKey: deps.servKey,
        baseUrl: deps.servBaseUrl,
        model,
      },
    );
    verdictServProof = judged.proof;
    verdictServOk = judged.ok;
    verdictServText = judged.ok ? judged.text : null;
    steps.push({
      id: "serv_verdict_decide",
      status: judged.ok ? "ok" : "fallback",
      detail: judged.ok ? judged.shadowOutcome : judged.error,
    });
  } else {
    steps.push({ id: "serv_verdict_decide", status: "skipped_no_key" });
  }

  const decision = previewDecision.gateRun.withheld
    ? previewDecision
    : resolveVerdictDecision({
        report: computed,
        servText: verdictServText,
        servOk: verdictServOk,
        hasServKey: Boolean(deps.servKey),
        mandate,
      });
  computed.verdict = decision.finalVerdict;
  computed.score = decision.finalAction === "withheld" ? null : computed.score;
  computed.decision = {
    action: decision.finalAction,
    source: decision.source,
    servChoice: decision.servChoice,
    deterministicAction: decision.deterministicAction,
    overrideReasons: decision.overrideReasons,
    labeledFallback: decision.labeledFallback,
    note: decision.note,
    withholdReason: decision.withholdReason,
    gates: decision.gateRun.gates.map((gate) => ({
      id: gate.id,
      status: gate.status,
      reason: gate.reason,
    })),
  };
  steps.push({
    id: "verdict_guardrails",
    status: decision.gateRun.withheld
      ? "withheld"
      : decision.overrideReasons.length > 0
        ? "overrode"
        : "passed",
    detail:
      decision.overrideReasons.slice(0, 3).join(" | ") ||
      `final=${decision.finalAction}; source=${decision.source}`,
  });

  // Independent second-pass challenge (counts as one SERV call when a key exists).
  let challengeProof: ServProof | null = null;
  const primaryForChallenge: Exclude<DecisionAction, "withheld"> | null =
    decision.finalAction === "withheld" ? null : (decision.finalAction as Exclude<DecisionAction, "withheld">);
  const challengeConfidence: AgentVerdictConfidence =
    decision.source === "serv" && decision.overrideReasons.length === 0 ? "high" : "medium";
  const challenge = decision.gateRun.withheld
    ? {
        result: {
          status: "not_run" as const,
          action: null,
          objection: null,
          evidenceIds: [] as string[],
          confidenceBefore: null,
          confidenceAfter: null,
        },
        proof: null,
      }
    : await runReportVerdictChallenge({
        report: computed,
        primaryAction: primaryForChallenge,
        confidence: challengeConfidence,
        allowedActions: decision.allowedActions.filter(
          (action): action is Exclude<DecisionAction, "withheld"> => action !== "withheld",
        ),
        hasBudget: true,
        servKey: deps.servKey,
        servBaseUrl: deps.servBaseUrl,
        model,
        fetchImpl,
      });
  challengeProof = challenge.proof;
  if (challenge.result.status === "not_run") {
    // Withheld verdicts do not spend a second call and do not claim a missing budget.
  } else if (challenge.result.status === "unavailable") {
    steps.push({
      id: "serv_verdict_challenge",
      status: "unavailable",
      detail: challenge.result.objection ?? "Second check did not finish.",
    });
  } else if (challenge.result.status === "skipped_no_budget" || challenge.result.status === "skipped_no_key") {
    steps.push({
      id: "serv_verdict_challenge",
      status: "skipped",
      detail: challenge.result.objection ?? challenge.result.status,
    });
  } else if (challenge.result.status === "ignored_malformed" || challenge.result.status === "ignored_no_evidence") {
    steps.push({
      id: "serv_verdict_challenge",
      status: "ignored",
      detail: challenge.result.status,
    });
  } else {
    steps.push({
      id: "serv_verdict_challenge",
      status: challenge.result.status,
      detail: challenge.result.objection ?? challenge.result.action ?? undefined,
    });
  }
  if (challenge.result.status === "disagreed" && challenge.result.confidenceAfter) {
    // Confidence lives on agentVerdict; primary action stays under hard gates.
  }

  const evidencePack = collectReportEvidenceIds(computed);
  const agentReasons = computed.reasons.slice(0, 4).map((text, index) => ({
    evidenceId: `ev_reason_${index}`,
    text,
  }));
  const agentRisks = computed.flags
    .filter((flag) => flag.level === "stop" || flag.level === "caution")
    .slice(0, 4)
    .map((flag, index) => ({
      evidenceId: `ev_flag_${index}`,
      text: flag.text,
    }));
  computed.agentVerdict = buildAgentVerdictFromReport({
    verdict: decision.finalAction,
    confidence:
      challenge.result.confidenceAfter ??
      (decision.gateRun.withheld ? null : challengeConfidence),
    reasons: agentReasons.filter((row) => evidencePack.ids.has(row.evidenceId)),
    risks: agentRisks.filter((row) => evidencePack.ids.has(row.evidenceId)),
    unknowns: computed.dataNotes.slice(0, 6),
    primaryNote: decision.note,
    primarySource: decision.source,
    secondPass: challenge.result,
    servCalls: [guardProof, verdictServProof, challengeProof].filter(Boolean).length,
    hadServStep: Boolean(verdictServOk && decision.servChoice),
  });

  let explanation = templateExplanation(computed);
  let explanationSource: Proof["explanationSource"] = "template";
  let usedModel: string | null = null;
  const servChecks: ServProof[] = deps.servKey
    ? [
        ...(guardProof ? [guardProof] : []),
        ...(verdictServProof ? [verdictServProof] : []),
        ...(challengeProof ? [challengeProof] : []),
      ]
    : [
        plannedProof(guardProfile),
        plannedProof("verdict_decide"),
        plannedProof("verdict_challenge"),
        plannedProof("check_rules"),
        plannedProof(explainProfile),
      ];
  const shadow = {
    requested: false,
    hint: SHADOW_HINT,
    maxIterations: SHADOW_MAX_ITERATIONS,
    outcome: deps.servKey ? "not_called" : "skipped_no_key",
  };

  if (deps.servKey) {
    shadow.requested = true;
    const facts = factsOf(computed);
    const allowed = JSON.stringify(facts);
    const rules = await runServ("check_rules", { user: JSON.stringify({ facts, userLookup: screened.text }) }, {
      fetch: fetchImpl,
      apiKey: deps.servKey,
      baseUrl: deps.servBaseUrl,
      model,
    });
    const rulesNote = rules.ok && quotedNumbersStayIn(rules.text, allowed) ? rules.text : null;
    if (!rulesNote) rules.proof.fallbackUsed = true;
    servChecks.push(rules.proof);
    const explained = await runServ(explainProfile, { user: JSON.stringify({ facts, userLookup: screened.text, rulesNote }), facts }, {
      fetch: fetchImpl,
      apiKey: deps.servKey,
      baseUrl: deps.servBaseUrl,
      model,
    });
    servChecks.push(explained.proof);
    if (!explained.ok) {
      shadow.outcome = "error";
      explanationSource = "unavailable";
      steps.push({ id: "serv_shadow_agent", status: "explanation_unavailable", detail: explained.error });
    } else {
      shadow.outcome = explained.shadowOutcome;
      usedModel = explained.model;
      const audit = auditExplanation(explained.text, computed);
      const shadowFailed = explained.shadowOutcome === "exhausted" || explained.shadowOutcome === "failed";
      if (audit.ok && !shadowFailed) {
        explanation = explained.text;
        explanationSource = "serv";
        steps.push({ id: "serv_shadow_agent", status: explained.shadowOutcome, detail: EXPLAIN_PROMPT_VERSION });
        steps.push({ id: "number_audit", status: "passed" });
      } else {
        steps.push({
          id: "serv_shadow_agent",
          status: "fallback_template",
          detail: shadowFailed ? explained.shadowOutcome : "number audit failed",
        });
        steps.push({
          id: "number_audit",
          status: audit.ok ? "passed_but_shadow_failed" : "failed",
          detail: audit.ok ? undefined : audit.offenders.slice(0, 8).join(", "),
        });
      }
    }
  } else {
    steps.push({ id: "serv_shadow_agent", status: "skipped", detail: "SERV_API_KEY is not set." });
    steps.push({ id: "number_audit", status: "template" });
  }

  const proof: Proof = {
    version: "autoflip.proof.v1",
    inputsHash: sha256Canonical({
      mode: input.mode,
      vin,
      zip: input.zip ?? null,
      subject: resolved.subject.vin,
      compVins: computed.comps.map((comp) => comp.vin).sort(),
      fairValueUsd: computed.fairValueUsd,
      verdict: computed.verdict,
      decisionAction: decision.finalAction,
    }),
    model: usedModel,
    promptVersion: EXPLAIN_PROMPT_VERSION,
    steps,
    toolOutputs: {
      verdict: computed.verdict,
      fairValueUsd: computed.fairValueUsd,
      priceGap: computed.priceGap,
      percentile: computed.percentile,
      compCount: computed.comps.length,
      score: computed.score,
      flip: computed.flip,
      recallCount: computed.recalls.length,
      openParkIt: computed.openParkIt,
      complaintCount: computed.complaintCount,
      fuel: computed.fuel,
      verdictDecision: {
        profile: "verdict_decide",
        deterministicAction: decision.deterministicAction,
        deterministicVerdict: decision.deterministicVerdict,
        servChoice: decision.servChoice,
        finalAction: decision.finalAction,
        finalVerdict: decision.finalVerdict,
        source: decision.source,
        overrideReasons: decision.overrideReasons,
        guardrailIds: decision.guardrails.map((rail) => rail.id),
        allowedActions: decision.allowedActions,
        labeledFallback: decision.labeledFallback,
        note: decision.note,
        withholdReason: decision.withholdReason,
        gates: decision.gateRun.gates.map((gate) => ({
          id: gate.id,
          status: gate.status,
          reason: gate.reason,
        })),
      },
    },
    explanationSource,
    servChecks,
    shadow,
  };

  const report: FullReport = {
    id: randomUUID(),
    createdAt: checkedAt,
    explanation,
    computed,
    proof,
  };
  return { ok: true, report };
}

async function distanceBetween(subject: Listing, zip: string | undefined, gov: GovDeps): Promise<number | null> {
  if (!zip || !subject.zip) return null;
  const [from, to] = await Promise.all([
    geocodeZipCity({ zip, city: null, state: null }, gov),
    geocodeZipCity({ zip: subject.zip, city: subject.city, state: subject.state }, gov),
  ]);
  if (!from || !to) return null;
  return Math.round(haversineMiles(from, to));
}

async function resolveSubject(
  vin: string,
  input: AssembleInput,
  deps: AssembleDeps,
  fetchImpl: typeof fetch,
): Promise<
  | {
      ok: true;
      subject: Listing;
      candidates: Listing[];
      sample: boolean;
      cached: boolean;
      geo: CompGeoScope;
      geographicConfidence: "nationwide" | "local_zip";
      compsProvenance: string;
    }
  | { ok: false; result: AssembleResult }
> {
  if (!deps.autodevKey || !deps.autodev) {
    return {
      ok: false,
      result: {
        ok: false,
        status: 503,
        error: "listings_unconfigured",
        message:
          "Live dealer listings are not configured in this environment. Open the labeled sample report instead of treating fixtures as a live lookup.",
      },
    };
  }

  const kv = deps.kv ?? getKv();
  const storeGate = requireSharedQuotaForPaidDispatch({
    kv,
    serverless: isServerlessRuntime(deps.env ?? process.env),
  });
  if (!storeGate.ok) {
    return {
      ok: false,
      result: {
        ok: false,
        status: 503,
        error: "quota_backend_not_distributed",
        message: storeGate.message,
      },
    };
  }

  const byVin = await autodevByVin(vin, {
    fetch: fetchImpl,
    cache: deps.autodev.cache,
    counter: deps.autodev.counter,
    apiKey: deps.autodevKey,
    now: deps.now,
    reserve: deps.autodev.reserve,
    signal: deps.autodev.signal,
    timeoutMs: deps.autodev.timeoutMs,
  });
  if (!byVin.ok) {
    const status = byVin.error === "demo_limit" ? 429 : byVin.status === 404 ? 404 : 502;
    return {
      ok: false,
      result: {
        ok: false,
        status,
        error: byVin.error === "demo_limit" ? "demo_limit" : "listings_error",
        message: byVin.message,
      },
    };
  }
  const subject = byVin.listings[0];
  if (!subject) {
    return {
      ok: false,
      result: {
        ok: false,
        status: 404,
        error: "not_found",
        message: "No vehicle came back for that VIN.",
      },
    };
  }

  // Report comps: use shopper ZIP when provided (local); otherwise nationwide.
  // Never read nationwide cached rows as local ZIP comps.
  const reportZip = input.zip?.replace(/\D/g, "").slice(0, 5) || null;
  const reportGeo: CompGeoScope = reportZip
    ? { kind: "zip", zip: reportZip, distanceMiles: 500 }
    : { kind: "nationwide" };

  const cached = await readComps(kv, {
    make: subject.make,
    model: subject.model,
    year: subject.year,
    geo: reportGeo,
  }).catch(() => null);
  if (cached && cached.listings.length > 0) {
    const candidates = cached.listings.some((item) => item.vin === subject.vin)
      ? cached.listings
      : [subject, ...cached.listings];
    return {
      ok: true,
      subject,
      candidates,
      sample: false,
      cached: true,
      geo: cached.geo,
      geographicConfidence: cached.geographicConfidence,
      compsProvenance: cached.provenanceNote,
    };
  }

  const searchZip = reportZip || undefined;
  const searchDistance = reportZip ? 500 : undefined;
  const searchGeo = geoScopeFromSearch({ searchZip, distanceMiles: searchDistance ?? null });
  const search = await autodevSearch(
    {
      make: subject.make,
      model: subject.model,
      year: input.year ?? subject.year,
      zip: searchZip,
      distanceMiles: searchDistance,
      limit: 20,
    },
    {
      fetch: fetchImpl,
      cache: deps.autodev.cache,
      counter: deps.autodev.counter,
      apiKey: deps.autodevKey,
      now: deps.now,
      reserve: deps.autodev.reserve,
      signal: deps.autodev.signal,
      timeoutMs: deps.autodev.timeoutMs,
    },
  );
  if (!search.ok) {
    return {
      ok: false,
      result: {
        ok: false,
        status: search.error === "demo_limit" ? 429 : 502,
        error: search.error === "demo_limit" ? "demo_limit" : "listings_error",
        message: search.message,
      },
    };
  }
  const candidates = search.listings.some((item) => item.vin === subject.vin)
    ? search.listings
    : [subject, ...search.listings];
  await rememberComps(kv, { make: subject.make, model: subject.model, geo: searchGeo }, candidates).catch(
    () => undefined,
  );
  return {
    ok: true,
    subject,
    candidates,
    sample: false,
    cached: byVin.cached && search.cached,
    geo: searchGeo,
    geographicConfidence: searchGeo.kind === "nationwide" ? "nationwide" : "local_zip",
    compsProvenance: `${geoScopeLabel(searchGeo)} — asking prices only, not closed sales.`,
  };
}

export async function assembleRadar(
  input: {
    make: string;
    model?: string;
    /** Optional body-style filter for Auto.dev (SUV, Truck, Sedan, …). */
    bodyStyle?: string;
    zip?: string;
    year?: number;
    yearMin?: number;
    yearMax?: number;
    /** Number = radius filter. `null` = nationwide (ZIP may still rank by distance). Omitted may still apply a legacy default when ZIP is set. */
    distanceMiles?: number | null;
    mode: Mode;
    priceMax?: number;
    milesMax?: number;
    /**
     * Find/Resale inventory fetch — skip per-query radar_guard (pure cost on
     * "Mazda CX-5 2020"). Deal Radar watches still run the guard by default.
     */
    skipRadarGuard?: boolean;
  },
  deps: AssembleDeps,
): Promise<
  | {
      ok: true;
      listings: Listing[];
      sample: boolean;
      message: string | null;
      proof: AgentProof;
      proofRecords: import("@/domain/decision-proof-record").DecisionProofRecord[];
    }
  | {
      ok: false;
      status: number;
      error: string;
      message: string;
      proof: AgentProof;
      proofRecords: import("@/domain/decision-proof-record").DecisionProofRecord[];
    }
> {
  const {
    buildDecisionProofRecord,
    RADAR_VERDICT_RUBRIC_ID,
  } = await import("@/domain/decision-proof-record");
  const { providerResponseIdFromCall } = await import("@/domain/serv-response-id");
  const screened = screenUserInput(
    [input.make, input.model, input.bodyStyle, input.zip, input.year?.toString(), input.yearMin?.toString(), input.yearMax?.toString()]
      .filter(Boolean)
      .join(" "),
  );
  const scanFields = ["score", "verdict", "reason", "priceUsd", "miles"];
  const recordedAt = new Date().toISOString();
  const guardInputs = {
    make: input.make,
    model: input.model ?? null,
    zip: input.zip ?? null,
    mode: input.mode,
  };
  if (!screened.ok) {
    const proofRecords = [
      buildDecisionProofRecord({
        purpose: "radar_guard",
        rubricId: RADAR_VERDICT_RUBRIC_ID,
        status: "skipped_no_evidence",
        recordedAt,
        inputs: guardInputs,
        detail: screened.reason,
      }),
    ];
    return {
      ok: false,
      status: 400,
      error: "rejected_input",
      message: screened.reason,
      proof: agentProof([plannedProof("radar_guard")], scanFields),
      proofRecords,
    };
  }
  const guard =
    input.skipRadarGuard
      ? null
      : deps.servKey?.trim()
        ? await runServ("radar_guard", { user: screened.text }, {
            fetch: deps.fetch ?? fetch,
            apiKey: deps.servKey,
            baseUrl: deps.servBaseUrl,
            model: deps.servModel,
          })
        : null;
  const proof = agentProof([guard?.proof ?? plannedProof("radar_guard")], scanFields);
  const guardDecision =
    guard && guard.ok ? interpretGuard(guard.text) : null;
  const guardStatus = input.skipRadarGuard
    ? "skipped_by_design"
    : !deps.servKey?.trim()
      ? "skipped_no_key"
      : !guard
        ? "skipped_no_key"
        : !guard.ok
          ? "error"
          : guardDecision === "block"
            ? "error"
            : "ok";
  const guardProofRecord = buildDecisionProofRecord({
    purpose: "radar_guard",
    rubricId: RADAR_VERDICT_RUBRIC_ID,
    status:
      guardStatus === "ok"
        ? "ok"
        : guardStatus === "skipped_no_key" || guardStatus === "skipped_by_design"
          ? "skipped_no_key"
          : "error",
    responseId: guard
      ? providerResponseIdFromCall({
          ok: guardStatus === "ok",
          id: typeof guard.proof.openserv?.id === "string" ? guard.proof.openserv.id : null,
        })
      : null,
    model: guard?.proof.modelReported ?? null,
    recordedAt,
    inputs: guardInputs,
    verdict: guardStatus === "ok" ? guardDecision : null,
    detail:
      guardStatus === "ok"
        ? null
        : input.skipRadarGuard
          ? "radar_guard skipped for Find inventory fetch (AUDIT: pure cost on make/model strings)."
          : !deps.servKey?.trim() || !guard
            ? "SERV_API_KEY is not configured — radar guard skipped."
            : !guard.ok
              ? guard.error
              : "radar_guard blocked this scan.",
  });
  const proofRecords = [guardProofRecord];
  const flipOpen = input.mode === "flip" && !input.make.trim();
  const bodyOnly = Boolean(input.bodyStyle?.trim()) && !input.make.trim();
  const budgetOnly = !input.make.trim() && !input.bodyStyle?.trim() && Boolean(input.priceMax);
  if (!input.make.trim() && !flipOpen && !bodyOnly && !budgetOnly) {
    return { ok: false, status: 400, error: "make_required", message: "Choose a make.", proof, proofRecords };
  }
  if (flipOpen && (!input.priceMax || !input.zip)) {
    return {
      ok: false,
      status: 400,
      error: "budget_required",
      message: "A flip scan needs a budget and a ZIP.",
      proof,
      proofRecords,
    };
  }
  if (!deps.autodevKey || !deps.autodev) {
    return {
      ok: false,
      status: 503,
      error: "listings_unconfigured",
      message:
        "Live dealer listings are not configured in this environment. Lemonless will not show sample inventory as search results.",
      proof,
      proofRecords,
    };
  }
  const kv = deps.kv ?? getKv();
  const storeGate = requireSharedQuotaForPaidDispatch({
    kv,
    serverless: isServerlessRuntime(deps.env ?? process.env),
  });
  if (!storeGate.ok) {
    return {
      ok: false,
      status: 503,
      error: "quota_backend_not_distributed",
      message: storeGate.message,
      proof,
      proofRecords,
    };
  }
  const fetchImpl = deps.fetch ?? fetch;
  const years = yearQuery(input);
  const search = await autodevSearch(
    {
      make: input.make.trim() || undefined,
      model: input.model?.trim() || undefined,
      bodyStyle:
        input.mode === "flip"
          ? input.bodyStyle?.trim() || undefined
          : passengerBodyStyleParam(input.bodyStyle),
      ...years,
      zip: input.zip,
      distanceMiles:
        typeof input.distanceMiles === "number"
          ? input.distanceMiles
          : input.distanceMiles === null
            ? undefined // explicit nationwide — do not invent 50/100; ZIP still ranks by distance
            : input.zip
              ? flipOpen
                ? 50
                : 100
              : undefined,
      priceRange: input.priceMax ? `1-${Math.round(input.priceMax * 1.05)}` : undefined,
      milesRange:
        input.mode === "flip"
          ? `0-${resaleMilesCap(input.milesMax)}`
          : input.milesMax
            ? `0-${Math.round(input.milesMax)}`
            : undefined,
      sort: input.mode === "flip" ? "price.asc" : undefined,
      limit: 20,
    },
    {
      fetch: fetchImpl,
      cache: deps.autodev.cache,
      counter: deps.autodev.counter,
      apiKey: deps.autodevKey,
      now: deps.now,
      // Persistent shared monthly ledger — must not silently fall back to MemoryCounter alone.
      reserve: deps.autodev.reserve,
      signal: deps.autodev.signal,
      timeoutMs: deps.autodev.timeoutMs,
    },
  );
  if (!search.ok) {
    return {
      ok: false,
      status: search.error === "demo_limit" ? 429 : 502,
      error: search.error === "demo_limit" ? "demo_limit" : "listings_error",
      message: search.message,
      proof,
      proofRecords,
    };
  }
  const listings =
    input.mode === "flip"
      ? postFilterFlipInventory(search.listings, {
          priceMax: input.priceMax,
          milesMax: input.milesMax,
          distanceMiles: typeof input.distanceMiles === "number" ? input.distanceMiles : null,
        })
      : search.listings;
  return {
    ok: true,
    listings,
    sample: false,
    message: search.listings.length === 0 ? "No listings came back for that search." : null,
    proof,
    proofRecords,
  };
}

/** Free price check. Listings and the public recall list only. No written explanation and no credit. */
export async function previewListing(input: AssembleInput, deps: AssembleDeps) {
  const lookupText = [input.url, input.vin, input.zip].filter(Boolean).join(" ");
  const screened = screenUserInput(lookupText || "");
  if (!screened.ok) return { ok: false as const, status: 400, error: "rejected_input", message: screened.reason };
  const vin = extractVin(input.vin || input.url || "");
  if (!vin) {
    return { ok: false as const, status: 400, error: "vin_required", message: "Paste a listing link that contains a VIN, or a 17-character VIN." };
  }
  const resolved = await resolveSubject(vin, input, deps, deps.fetch ?? fetch);
  if (!resolved.ok) return resolved.result;
  const subject = overlayStatedFacts(resolved.subject, input).listing;
  const recallLookup = await recallsFor(subject.make, subject.model, subject.year, { fetch: deps.fetch ?? fetch });
  const badge = priceBadge(subject, resolved.candidates);
  const campaignCount = recallLookup.records.length;
  // parkIt ≠ parkOutside: only parkIt is a do-not-drive signal; parkOutside is outdoor parking guidance.
  const parkIt = recallLookup.records.some((item) => item.parkIt);
  const parkOutside = recallLookup.records.some((item) => item.parkOutSide);
  const parkNote = parkIt
    ? " At least one is a park-it (do not drive) campaign — verify VIN applicability and repair status before driving (model coverage is not VIN unrepaired proof)."
    : parkOutside
      ? " At least one includes outdoor-parking guidance — not a do-not-drive park-it claim by itself; verify VIN applicability."
      : " Verify VIN applicability and repair status with the dealer; absence of a do-not-drive or outdoor-parking flag is not VIN-cleared.";
  const reasons = [
    badge.deltaLabel ?? badge.label,
    !recallLookup.available
      ? "NHTSA recall lookup was unavailable. Unknown is not cleared — check this VIN directly with NHTSA and the dealer."
      : campaignCount > 0
        ? `${campaignCount} model-year recall campaign${campaignCount === 1 ? "" : "s"} returned by NHTSA.${parkNote}`
        : "NHTSA returned no campaigns for this model year, make and model. This does not confirm the VIN has no open recall.",
  ];
  const coverageInput = {
    mode: input.mode,
    sample: resolved.sample,
    dealerListingCount: resolved.candidates.filter((item) => item.vin !== subject.vin && item.priceUsd !== null).length,
    radiusMiles: input.zip || subject.zip ? 100 : null,
    historyOnListing: subject.accidentCount !== null,
  };
  return {
    ok: true as const,
    sample: resolved.sample,
    vin: subject.vin,
    title: `${subject.year} ${subject.make} ${subject.model}`,
    badge,
    reasons,
    coverage: coverageSentence(coverageInput),
    coverageLevel: coverageConfidence(coverageInput),
  };
}

function yearQuery(input: { year?: number; yearMin?: number; yearMax?: number }): { year?: number; yearRange?: string } {
  return providerYearQuery(input);
}
