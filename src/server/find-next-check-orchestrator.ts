/**
 * Authenticated Find next-check orchestrator.
 *
 * Owned searchContextToken → load server need/listings → claim fence (keyed) →
 * SERV find_next_check (allowlist) → apply in code → rematch with NEW need →
 * persist updated context. Client need/listings are never authoritative.
 *
 * Keyless path: deterministic allowlist apply only — source=deterministic_fallback,
 * autonomousServ=false (must not masquerade as SERV autonomy).
 */
import type { DecisionProof } from "@/domain/decision-note";
import { selectBestDealOnEvidence } from "@/domain/find-best-deal";
import {
  executeCarConsistency,
  mergeCarConsistency,
  type CarConsistencyReceipt,
} from "@/domain/find-car-consistency";
import { top5Ranks, type FindDecisionLogEntry } from "@/domain/find-decision-log";
import type { FindBaselineDelta } from "@/domain/find-baseline";
import {
  executeFindFreeGovCheck,
  fingerprintFreeGovReceipts,
  freeGovReceiptsBrief,
  freeGovToolCoverage,
  fuelsByModelKeyFromReceipts,
  isFindFreeGovCheckId,
  type FindFreeGovReceipt,
} from "@/domain/find-free-gov";
import {
  countRemainingAutomaticChecks,
  decideFindNextCheckLoop,
  fingerprintListings,
  fingerprintNeed,
  isUserActionFindCheck,
  type FindNextCheckLoopDisposition,
} from "@/domain/find-next-check-loop";
import { applyFindNextCheck, buildGroundedShortlistWithRisk, type FindSearchRefine } from "@/domain/find-path";
import { proposeFindNextChecks } from "@/domain/find-next-checks";
import {
  clampFindNextCheckTargetKeys,
  resolveConsistencyTargetKeys,
} from "@/domain/find-next-check-choice";
import {
  mergeFreeGovReceiptsByMmy,
  riskCoverageHonesty,
} from "@/domain/find-risk-evidence";
import {
  countNonFreeAllowlistChoices,
  fingerprintBestDealShortlist,
  shouldInvokeServForFindNextCheck,
} from "@/domain/find-serv-budget";
import { compareObservedModels } from "@/domain/find-model-observe";
import { softPrefGapsFromText, type StructuredNeed } from "@/domain/need";
import type { ScoutFreeGovPort } from "@/domain/scout/free-gov";
import type { Kv } from "@/io/kv";
import {
  appliedFingerprint,
  claimFindNextCheckAction,
  completeFindNextCheckAction,
  findNextCheckClaimHeld,
  logFindNextCheckServSpend,
  releaseFindNextCheckAction,
  reserveFindNextCheckPaidSlot,
  type FindNextCheckActionIdentity,
} from "@/server/find-next-check-claim";
import {
  runFindNextCheckLive,
  type FindNextCheckLiveDeps,
  type FindNextCheckLiveOk,
} from "@/server/find-next-check-live";
import {
  listingFactsFromCompsPool,
  listingsFromMatchDirections,
  loadFindSearchContext,
  marketPoolFromListingFacts,
  updateFindSearchContext,
  type FindSearchContextRecord,
  type FindSearchListingFact,
} from "@/server/find-search-context";

export type MatchRematchBody = {
  ok?: boolean;
  directions?: Array<{ listings?: unknown[] }>;
  message?: string | null;
  headline?: string | null;
  nextStep?: string | null;
  scope?: string | null;
  emptyReason?: string | null;
  partialFailure?: boolean;
  affordabilityAssessed?: boolean;
  sample?: boolean;
};

export type MatchRunner = (
  body: { need: StructuredNeed; refine?: FindSearchRefine },
) => Promise<{
  ok: boolean;
  status: number;
  body: MatchRematchBody;
}>;

export type FindNextCheckOrchestratorDeps = FindNextCheckLiveDeps & {
  kv: Kv;
  userId: string;
  /** Injected rematch — production wires runFindMatch. */
  runMatch?: MatchRunner;
  /** Injected free-gov port — offline tests use mock/unsupported; live uses createLiveFreeGovPort. */
  freeGovPort?: ScoutFreeGovPort;
};

/** Public, secret-free diagnostics when autonomy did not engage. */
export type KeyedAutonomyDiag = {
  keyed: boolean;
  /** What /api/match minted into search context (may differ if env drifted). */
  mintSaidKeyed: boolean;
  autonomousServ: boolean;
  source: "serv" | "deterministic_fallback";
  failureCategory: string | null;
  failureReasonCode: string | null;
  /**
   * Actionable deploy hint — never includes key material or raw model text.
   * Parent configures Vercel; this only names which check to perform.
   */
  configHint: string | null;
};

export type FindNextCheckOrchestratorOk = {
  ok: true;
  searchContextToken: string;
  source: "serv" | "deterministic_fallback";
  /** True only when SERV actually chose (keyed + parse + clamp). */
  autonomousServ: boolean;
  replay: boolean;
  chosenId: string;
  servNote: string | null;
  replan: FindNextCheckLiveOk["replan"];
  research: boolean;
  allowedChecks: FindNextCheckLiveOk["allowedChecks"];
  compare: FindNextCheckLiveOk["compare"];
  shortlist: FindNextCheckLiveOk["shortlist"];
  proofs: DecisionProof[];
  failureDiag: FindNextCheckLiveOk["failureDiag"];
  clampDiag: FindNextCheckLiveOk["clampDiag"];
  keyedAutonomyDiag: KeyedAutonomyDiag;
  honesty: string;
  /** Rematch payload when research — always built from NEW need after apply. */
  rematch: {
    ok: boolean;
    status: number;
    body: MatchRematchBody;
  } | null;
  needAfter: StructuredNeed;
  appliedCheckIds: string[];
  /** Free public government receipts after this step (server-owned; may be empty). */
  freeGovReceipts: FindFreeGovReceipt[];
  freeEvidenceNote: string | null;
  /** Honest year/make/model sample coverage vs full listing inventory (never claims fleet-wide clearance). */
  riskCoverage: ReturnType<typeof riskCoverageHonesty>;
  /** Per-tool free year/make/model progress — allowlist continuation signal. */
  freeGovCoverage: ReturnType<typeof freeGovToolCoverage>;
  /** Deterministic best-deal ranking from code (not SERV-invented scores). */
  bestDeal: ReturnType<typeof selectBestDealOnEvidence>;
  /** Ordinary UI auto-continues when continue=true (no hidden step quota). */
  loop: FindNextCheckLoopDisposition;
  /** Paid SERV find_next_check HTTP calls so far this Find (after this hop). */
  servPaidCalls: number;
  /** Why SERV ran or was skipped this hop (bounded drain accounting). */
  servInvokeReason: string;
  /** Append-only hop log. Buyer UI must format it; do not render raw fields. */
  decisionLog: FindDecisionLogEntry[];
  /** Cheapest-in-budget and lowest-miles-in-budget on this same list. */
  baseline: FindBaselineDelta;
  /** Per-car consistency receipts after this hop. */
  carChecks: CarConsistencyReceipt[];
  /** Cars this hop's per-car check actually ran on (empty when not per-car). */
  targetKeys: string[];
};

export function buildKeyedAutonomyDiag(input: {
  keyed: boolean;
  mintSaidKeyed: boolean;
  autonomousServ: boolean;
  source: "serv" | "deterministic_fallback";
  failureDiag: FindNextCheckLiveOk["failureDiag"];
  clampDiag?: FindNextCheckLiveOk["clampDiag"];
}): KeyedAutonomyDiag {
  const failureCategory = input.failureDiag?.category ?? null;
  const failureReasonCode = input.failureDiag?.reasonCode ?? null;
  let configHint: string | null = null;
  if (!input.keyed && input.mintSaidKeyed) {
    configHint =
      "ENV_DRIFT: search context minted with SERV keyed, but SERV_API_KEY is missing on /api/find/next-check runtime — set the same SERV_API_KEY on this Vercel deployment/function (value never logged).";
  } else if (!input.keyed) {
    configHint =
      "Set SERV_API_KEY on the Vercel deployment that serves /api/match and /api/find/next-check (same project env). Without it, Find uses deterministic allowlist only.";
  } else if (!input.autonomousServ) {
    const denied = input.clampDiag?.deniedCheckId;
    const allow = input.clampDiag?.allowlistIds?.join(",") ?? "";
    configHint =
      failureCategory === "http_error" || failureReasonCode?.includes("timeout")
        ? "SERV find_next_check timed out or HTTP-failed under profile timeout — check OpenServ latency for gpt-5.4-mini; failureDiag has category/reasonCode only (no secrets)."
        : denied
          ? `SERV returned checkId outside allowlist: denied=${denied} allowlist=[${allow}]. Live request schema enum is bound to allowlist; inspect clampDiag. Do not treat as missing-key.`
          : "SERV find_next_check did not return an allowlisted checkId (parse/clamp/refusal). Inspect failureDiag + clampDiag; confirm SERV_API_KEY + SERV_BASE_URL on this deployment. Do not treat as missing-key.";
  }
  return {
    keyed: input.keyed,
    mintSaidKeyed: input.mintSaidKeyed,
    autonomousServ: input.autonomousServ,
    source: input.source,
    failureCategory,
    failureReasonCode,
    configHint,
  };
}

export type FindNextCheckOrchestratorErr = {
  ok: false;
  status: number;
  error: string;
  message: string;
};

function publicResultPayload(ok: FindNextCheckOrchestratorOk): string {
  // Stable subset for receipt replay — exclude bulky proofs text if any.
  return JSON.stringify({
    ok: true,
    searchContextToken: ok.searchContextToken,
    source: ok.source,
    autonomousServ: ok.autonomousServ,
    chosenId: ok.chosenId,
    servNote: ok.servNote,
    replan: ok.replan,
    research: ok.research,
    allowedChecks: ok.allowedChecks,
    compare: ok.compare,
    failureDiag: ok.failureDiag
      ? {
          category: ok.failureDiag.category,
          reasonCode: ok.failureDiag.reasonCode,
          refusalFieldBytes: ok.failureDiag.fields.refusalFieldBytes,
          usagePresent: Boolean(ok.failureDiag.usage),
        }
      : null,
    clampDiag: ok.clampDiag
      ? {
          deniedCheckId: ok.clampDiag.deniedCheckId,
          allowlistIds: ok.clampDiag.allowlistIds,
          aliasApplied: ok.clampDiag.aliasApplied,
          reasonCode: ok.clampDiag.reasonCode,
        }
      : null,
    keyedAutonomyDiag: ok.keyedAutonomyDiag,
    honesty: ok.honesty,
    rematch: ok.rematch,
    needAfter: ok.needAfter,
    appliedCheckIds: ok.appliedCheckIds,
    freeGovReceipts: ok.freeGovReceipts,
    freeEvidenceNote: ok.freeEvidenceNote,
    riskCoverage: ok.riskCoverage,
    freeGovCoverage: ok.freeGovCoverage,
    loop: ok.loop,
    proofs: ok.proofs,
    bestDeal: ok.bestDeal,
    servPaidCalls: ok.servPaidCalls,
    servInvokeReason: ok.servInvokeReason,
    decisionLog: ok.decisionLog,
    baseline: ok.baseline,
    carChecks: ok.carChecks,
    targetKeys: ok.targetKeys,
  });
}

function rankFindOnSamePool(input: {
  need: FindSearchContextRecord["need"];
  listings: FindSearchContextRecord["listings"];
  receipts: FindSearchContextRecord["freeGovReceipts"];
  carChecks: readonly CarConsistencyReceipt[];
  compsPool: FindSearchContextRecord["listings"];
}) {
  return selectBestDealOnEvidence({
    need: input.need,
    listings: input.listings,
    receipts: input.receipts,
    carChecks: input.carChecks,
    marketPool: marketPoolFromListingFacts(input.compsPool),
  });
}

function carCheckFingerprint(checks: readonly CarConsistencyReceipt[]): string {
  return JSON.stringify(
    checks
      .map((row) => ({
        key: row.key,
        excluded: row.identityMismatch,
        penalty: row.conditionPenalty,
        questions: row.sellerQuestions.length,
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  );
}

function freePublicWorkOpen(ctx: FindSearchContextRecord): boolean {
  const receipts = ctx.freeGovReceipts ?? [];
  const coverage = freeGovToolCoverage(ctx.listings, receipts);
  if (coverage.anyUnchecked) return true;
  const carChecks = ctx.carChecks ?? [];
  const best = rankFindOnSamePool({
    need: ctx.need,
    listings: ctx.listings,
    receipts,
    carChecks,
    compsPool: ctx.compsPool ?? ctx.listings,
  });
  const checked = new Set(carChecks.map((row) => row.key));
  return best.ranked.some((car) => !checked.has(car.key));
}

/** Finished search: same buyer payload, no new check and no paid call. */
function settledFindReplay(
  ctx: FindSearchContextRecord,
  deps: FindNextCheckOrchestratorDeps,
): FindNextCheckOrchestratorOk {
  const receipts = ctx.freeGovReceipts ?? [];
  const carChecks = ctx.carChecks ?? [];
  const bestDeal = rankFindOnSamePool({
    need: ctx.need,
    listings: ctx.listings,
    receipts,
    carChecks,
    compsPool: ctx.compsPool ?? ctx.listings,
  });
  const coverage = freeGovToolCoverage(ctx.listings, receipts);
  const fuels = fuelsByModelKeyFromReceipts(receipts);
  const shortlistPack = buildGroundedShortlistWithRisk(ctx.need, ctx.listings, fuels, receipts);
  const listingsHaveVin = ctx.listings.some(
    (row) => typeof row.vin === "string" && row.vin.trim().length >= 11,
  );
  const allowed = proposeFindNextChecks({
    need: ctx.need,
    softGaps: softPrefGapsFromText(ctx.need.note),
    observedListingCount: ctx.listings.length,
    observedModelCount: new Set(ctx.listings.map((row) => `${row.make}|${row.model}`)).size,
    emptyInventory: ctx.listings.length === 0,
    appliedCheckIds: ctx.appliedCheckIds,
    listingsHaveVin,
    freeGovCoverage: coverage,
    consistencyStillOpen: false,
  });
  const lastAction = ctx.decisionLog?.[ctx.decisionLog.length - 1]?.action ?? "compare_observed_asks";
  const keyed = Boolean(deps.servKey?.trim());
  return {
    ok: true,
    searchContextToken: ctx.token,
    source: "deterministic_fallback",
    autonomousServ: false,
    replay: true,
    chosenId: lastAction,
    servNote: null,
    replan: {
      need: ctx.need,
      refine: ctx.refine,
      note: "Checks already finished for this search.",
      research: false,
    },
    research: false,
    allowedChecks: allowed,
    compare: compareObservedModels(ctx.listings, fuels),
    shortlist: shortlistPack.entries,
    proofs: [],
    failureDiag: null,
    clampDiag: null,
    keyedAutonomyDiag: buildKeyedAutonomyDiag({
      keyed,
      mintSaidKeyed: Boolean(ctx.servNextCheckEnabled),
      autonomousServ: false,
      source: "deterministic_fallback",
      failureDiag: null,
    }),
    honesty: "Checks already finished for this search. No new paid step.",
    rematch: null,
    needAfter: ctx.need,
    appliedCheckIds: ctx.appliedCheckIds,
    freeGovReceipts: receipts,
    freeEvidenceNote: null,
    riskCoverage: shortlistPack.coverage,
    freeGovCoverage: coverage,
    bestDeal,
    loop: {
      continue: false,
      reason: "grounded_stop",
      detail: "Free public checks already finished for this search. Reloading does not start another check.",
    },
    servPaidCalls: ctx.servPaidCalls ?? 0,
    servInvokeReason: "no_decision_change",
    decisionLog: ctx.decisionLog ?? [],
    baseline: bestDeal.baseline,
    carChecks,
    targetKeys: [],
  };
}

export async function runFindNextCheckOrchestrator(
  input: { searchContextToken?: string | null },
  deps: FindNextCheckOrchestratorDeps,
): Promise<FindNextCheckOrchestratorOk | FindNextCheckOrchestratorErr> {
  const loaded = await loadFindSearchContext(deps.kv, {
    userId: deps.userId,
    token: input.searchContextToken,
  });
  if (!loaded.ok) {
    return {
      ok: false,
      status: loaded.reason === "missing_token" ? 400 : 404,
      error: "search_context_invalid",
      message: loaded.message,
    };
  }
  const ctx = loaded.record;
  const identity: FindNextCheckActionIdentity = {
    userId: deps.userId,
    searchContextToken: ctx.token,
    appliedFingerprint: appliedFingerprint(ctx.appliedCheckIds),
  };

  const keyed = Boolean(deps.servKey?.trim());
  if (ctx.loopSettled === true && !freePublicWorkOpen(ctx)) {
    return settledFindReplay(ctx, deps);
  }
  let claimId: string | null = null;
  let replay = false;

  if (keyed) {
    const claim = await claimFindNextCheckAction(deps.kv, identity);
    if (claim.kind === "in_progress") {
      return {
        ok: false,
        status: 409,
        error: "next_check_in_progress",
        message: "Those checks are already running for this search. Wait a moment, then try again.",
      };
    }
    if (claim.kind === "conflict") {
      return {
        ok: false,
        status: 409,
        error: "next_check_conflict",
        message: `Next-check claim conflict (${claim.reason}).`,
      };
    }
    if (claim.kind === "replay") {
      try {
        const parsed = JSON.parse(claim.receipt.resultJson) as FindNextCheckOrchestratorOk;
        return { ...parsed, ok: true, replay: true };
      } catch {
        return {
          ok: false,
          status: 500,
          error: "corrupt_replay",
          message: "Stored next-check receipt unreadable.",
        };
      }
    }
    claimId = claim.claimId;
  }

  try {
    const priorReceipts = ctx.freeGovReceipts ?? [];
    const priorCoverage = freeGovToolCoverage(ctx.listings, priorReceipts);
    const softGapsPrior = softPrefGapsFromText(ctx.need.note);
    const listingsHaveVinPrior = ctx.listings.some(
      (l) => typeof l.vin === "string" && l.vin.trim().length >= 11,
    );
    const priorCarChecks = ctx.carChecks ?? [];
    const priorPool = ctx.compsPool ?? ctx.listings;
    const priorBestDeal = rankFindOnSamePool({
      need: ctx.need,
      listings: ctx.listings,
      receipts: priorReceipts,
      carChecks: priorCarChecks,
      compsPool: priorPool,
    });
    const checkedCarKeys = new Set(priorCarChecks.map((row) => row.key));
    const consistencyStillOpen = priorBestDeal.ranked.some((car) => !checkedCarKeys.has(car.key));
    const priorProposedOpen = proposeFindNextChecks({
      need: ctx.need,
      softGaps: softGapsPrior,
      observedListingCount: ctx.listings.length,
      observedModelCount: new Set(ctx.listings.map((l) => `${l.make}|${l.model}`)).size,
      emptyInventory: ctx.listings.length === 0,
      appliedCheckIds: ctx.appliedCheckIds,
      listingsHaveVin: listingsHaveVinPrior,
      freeGovCoverage: priorCoverage,
      consistencyStillOpen,
    });
    const priorAllowedIds = priorProposedOpen.map((c) => c.id);
    const priorFreeGovCount = priorAllowedIds.filter((id) => isFindFreeGovCheckId(id)).length;
    const shortlistFp = fingerprintBestDealShortlist(priorBestDeal.ranked);
    const paidSoFar = ctx.servPaidCalls ?? 0;
    const retargetPending = ctx.servRetargetPending === true;
    const servDecision = shouldInvokeServForFindNextCheck({
      paidCallsSoFar: paidSoFar,
      remainingFreeGovCount: priorFreeGovCount,
      nonFreeChoiceCount: countNonFreeAllowlistChoices(priorAllowedIds),
      shortlistFp,
      lastServShortlistFp: ctx.lastServShortlistFp ?? null,
      neverCalledServ: paidSoFar === 0,
      consistencyOpen: consistencyStillOpen && priorAllowedIds.includes("free_car_consistency"),
      offerServRetarget: retargetPending,
    });
    let servHttpAttempts = 0;
    let skipPaidSlot = false;
    if (keyed && servDecision.invoke && claimId) {
      const slot = await reserveFindNextCheckPaidSlot(deps.kv, identity, claimId);
      servHttpAttempts = 1;
      skipPaidSlot = slot === "already_reserved";
    }
    const live = await runFindNextCheckLive(
      {
        need: ctx.need,
        listings: ctx.listings,
        refine: ctx.refine,
        appliedCheckIds: ctx.appliedCheckIds,
        freeGovBrief: freeGovReceiptsBrief(priorReceipts),
        freeGovCoverage: priorCoverage,
        consistencyStillOpen,
        top5: priorBestDeal.ranked.slice(0, 5).map((car, index, rows) => ({
          key: car.key,
          rank: index + 1,
          label: `${car.year} ${car.make} ${car.model}`,
          score: car.score,
          gapToAhead: index === 0 ? 0 : Math.round((rows[index - 1]!.score - car.score) * 10) / 10,
          unknowns: car.unknowns.slice(0, 4),
        })),
      },
      {
        servKey: deps.servKey,
        servModel: deps.servModel,
        servBaseUrl: deps.servBaseUrl,
        fetchImpl: deps.fetchImpl,
        env: deps.env,
        skipServ: (keyed && !servDecision.invoke) || skipPaidSlot,
        skipServReason: skipPaidSlot ? "paid_already_reserved" : servDecision.reason,
      },
    );

    if (!live.ok) {
      if (claimId) await releaseFindNextCheckAction(deps.kv, identity, claimId);
      return live;
    }

    const nextPaidCallsPreview = paidSoFar + servHttpAttempts;
    if (claimId && servHttpAttempts > 0) {
      await logFindNextCheckServSpend(deps.kv, identity, claimId, {
        profile: "find_next_check",
        httpAttempts: servHttpAttempts,
        source: live.source,
        servPaidCalls: nextPaidCallsPreview,
        invokeReason: servDecision.reason,
      });
    }

    // SERV chooses order, targets, and the non-free next step. A paid or manual
    // suggestion does not run, and is not recorded as applied, while free public
    // checks are still open. Code runs the next free check instead.
    const freeWorkOpen =
      priorFreeGovCount > 0 ||
      (consistencyStillOpen && priorAllowedIds.includes("free_car_consistency"));
    let executedId = live.chosenId;
    let executedTargets = live.targetKeys;
    let replan = live.replan;
    const servChoseExecuted = live.source === "serv";
    const overrodeUserAction = freeWorkOpen && isUserActionFindCheck(live.chosenId);
    if (overrodeUserAction) {
      const nextFree = priorProposedOpen.find(
        (check) => isFindFreeGovCheckId(check.id) || check.id === "free_car_consistency",
      );
      if (nextFree) {
        executedId = nextFree.id;
        executedTargets = [];
        replan = applyFindNextCheck(ctx.need, nextFree.id, ctx.refine);
      }
    }
    const ranServChoice = servChoseExecuted && executedId === live.chosenId;
    const consumedRetarget = retargetPending && servHttpAttempts > 0;
    const lostInitialDecision =
      skipPaidSlot &&
      paidSoFar === 0 &&
      (isFindFreeGovCheckId(executedId) || executedId === "free_car_consistency");
    const armedRetarget =
      (overrodeUserAction && executedId !== live.chosenId) || lostInitialDecision;
    const nextRetarget = consumedRetarget ? false : retargetPending || armedRetarget;

    const appliedNext = [...ctx.appliedCheckIds, executedId];
    let rematch: FindNextCheckOrchestratorOk["rematch"] = null;
    let listingsAfter = ctx.listings;
    let compsPoolAfter: FindSearchListingFact[] = ctx.compsPool ?? ctx.listings;
    let refineAfter = replan.refine;
    let rematchOk: boolean | null = null;
    let freeGovReceipts = priorReceipts;
    let hopReceipts: FindFreeGovReceipt[] = [];
    let freeEvidenceNote: string | null = null;
    let carChecks = priorCarChecks;
    const top5Keys = priorBestDeal.ranked.slice(0, 5).map((car) => car.key);
    const consistencyTargets =
      executedId === "free_car_consistency"
        ? resolveConsistencyTargetKeys(executedTargets, top5Keys, checkedCarKeys)
        : [];
    // Explicit vehicle-spec targets only. An empty list keeps the normal unchecked batch
    // so a null target list cannot pin the check to three cars and stall the rest.
    const vpicTargets =
      executedId === "free_gov_vpic" ? clampFindNextCheckTargetKeys(executedTargets, top5Keys) : [];
    const targetKeys = executedId === "free_car_consistency" ? consistencyTargets : vpicTargets;

    if (replan.research && deps.runMatch) {
      // CRITICAL: rematch uses NEW need from apply — never pre-apply / stale UI years.
      const matchResult = await deps.runMatch({
        need: replan.need,
        refine: replan.refine,
      });
      rematch = {
        ok: matchResult.ok && Boolean(matchResult.body.ok !== false),
        status: matchResult.status,
        body: matchResult.body,
      };
      rematchOk = rematch.ok;
      if (rematch.ok && Array.isArray(matchResult.body.directions)) {
        listingsAfter = listingsFromMatchDirections(
          matchResult.body.directions as Parameters<typeof listingsFromMatchDirections>[0],
        );
        const rawComps = (matchResult.body as { compsPool?: unknown }).compsPool;
        compsPoolAfter = Array.isArray(rawComps)
          ? listingFactsFromCompsPool(
              rawComps as Parameters<typeof listingFactsFromCompsPool>[0],
            )
          : listingsAfter;
      }
    } else if (replan.research && !deps.runMatch) {
      rematch = null; // client must rematch with returned needAfter only
      rematchOk = null;
    }

    // Free public government tools — autonomous, no Report credit, reuses Scout free-gov port.
    if (replan.freeEvidence) {
      const executed = await executeFindFreeGovCheck({
        checkId: executedId,
        listings: listingsAfter,
        priorReceipts,
        gov: deps.freeGovPort,
        shopperNote: replan.need.note,
        targetKeys: executedId === "free_gov_vpic" && vpicTargets.length > 0 ? vpicTargets : undefined,
      });
      if (executed) {
        // Only this hop's receipts belong in the decision log. Merged history is new
        // objects, so an identity check against the prior array logged the same lines again.
        hopReceipts = executed.receipts;
        // Dedup by checkId+year/make/model so cached re-runs cannot append duplicate receipts / fake cycles.
        if (executed.receipts.length > 0) {
          freeGovReceipts = mergeFreeGovReceiptsByMmy(priorReceipts, executed.receipts);
        }
        freeEvidenceNote = executed.note;
        replan = {
          ...replan,
          note: `${replan.note} ${executed.note}`.trim(),
        };
      }
    }

    const newCarChecks =
      executedId === "free_car_consistency"
        ? executeCarConsistency({
            listings: listingsAfter,
            targetKeys: consistencyTargets,
            vpicReceipts: freeGovReceipts,
          })
        : [];
    if (newCarChecks.length > 0) {
      carChecks = mergeCarConsistency(priorCarChecks, newCarChecks);
    }

    const nextPaidCalls = nextPaidCallsPreview;
    if (claimId && !(await findNextCheckClaimHeld(deps.kv, identity, claimId))) {
      return {
        ok: false,
        status: 409,
        error: "next_check_in_progress",
        message: "Those checks were already picked up. Wait a moment, then try again.",
      };
    }
    const updated: FindSearchContextRecord = await updateFindSearchContext(deps.kv, ctx, {
      need: replan.need,
      refine: refineAfter,
      listings: listingsAfter,
      compsPool: compsPoolAfter,
      appliedCheckIds: appliedNext,
      freeGovReceipts,
      servPaidCalls: nextPaidCalls,
      lastServShortlistFp:
        servHttpAttempts > 0 ? shortlistFp : (ctx.lastServShortlistFp ?? null),
      carChecks,
      servRetargetPending: nextRetarget,
    });

    const fuelsByModelKey = fuelsByModelKeyFromReceipts(freeGovReceipts);
    // Shortlist + remaining checks from POST-apply / POST-rematch / free-gov evidence.
    const shortlistPack = buildGroundedShortlistWithRisk(
      updated.need,
      updated.listings,
      fuelsByModelKey,
      freeGovReceipts,
    );
    // Prefer full provider comps pool (pre-diversify) so same-model peers are not limited
    // to the 24 shown cards — badge and score share resolveMarketComps on this pool.
    const bestDeal = rankFindOnSamePool({
      need: updated.need,
      listings: updated.listings,
      receipts: freeGovReceipts,
      carChecks,
      compsPool: updated.compsPool ?? updated.listings,
    });
    const shortlistAfter = shortlistPack.entries;
    const riskCoverage = shortlistPack.coverage;
    const softGaps = softPrefGapsFromText(updated.need.note);
    const listingsHaveVin = updated.listings.some(
      (l) => typeof l.vin === "string" && l.vin.trim().length >= 11,
    );
    const coverageAfter = freeGovToolCoverage(updated.listings, freeGovReceipts);
    const checkedAfter = new Set(carChecks.map((row) => row.key));
    const consistencyStillOpenAfter = bestDeal.ranked.some((car) => !checkedAfter.has(car.key));
    const remainingProposed = proposeFindNextChecks({
      need: updated.need,
      softGaps,
      observedListingCount: updated.listings.length,
      observedModelCount: new Set(updated.listings.map((l) => `${l.make}|${l.model}`)).size,
      emptyInventory: updated.listings.length === 0,
      appliedCheckIds: appliedNext,
      listingsHaveVin,
      freeGovCoverage: coverageAfter,
      consistencyStillOpen: consistencyStillOpenAfter,
    });
    const remainingActionableCount = countRemainingAutomaticChecks(
      remainingProposed.map((c) => c.id),
      appliedNext,
    );
    const remainingFreeGovCount = remainingProposed.filter((c) =>
      isFindFreeGovCheckId(c.id),
    ).length;

    const evidenceAdded: string[] = [];
    for (const receipt of hopReceipts) {
      const plain = receipt.evidenceFacts?.[0]?.plain;
      if (plain) evidenceAdded.push(plain);
    }
    for (const check of newCarChecks) {
      for (const fact of check.fields) {
        if (fact.state === "issue_found" || fact.field === "days_listed") evidenceAdded.push(fact.plain);
      }
      if (check.excludedReason) evidenceAdded.push(check.excludedReason);
    }
    const loggedTargets =
      targetKeys.length > 0
        ? targetKeys
        : newCarChecks.map((row) => row.key);
    const decisionEntry: FindDecisionLogEntry = {
      hop: (ctx.decisionLog?.length ?? 0) + 1,
      decidedBy: ranServChoice ? "SERV" : "code",
      invokeReason: servDecision.reason,
      action: executedId,
      targetCars: loggedTargets.slice(0, 3),
      evidenceAdded: evidenceAdded.slice(0, 4),
      top5Before: top5Ranks(priorBestDeal.ranked),
      top5After: top5Ranks(bestDeal.ranked),
      pickBefore: priorBestDeal.pick?.key ?? null,
      pickAfter: bestDeal.pick?.key ?? null,
    };
    const decisionLog = [...(ctx.decisionLog ?? []), decisionEntry].slice(-24);
    updated.decisionLog = decisionLog;
    const consistencyFp =
      executedId === "free_car_consistency"
        ? fingerprintBestDealShortlist(bestDeal.ranked)
        : undefined;
    if (consistencyFp) updated.lastServShortlistFp = consistencyFp;
    await updateFindSearchContext(deps.kv, updated, {
      decisionLog,
      ...(consistencyFp ? { lastServShortlistFp: consistencyFp } : {}),
    });

    const autonomousServ = live.source === "serv";
    const mintSaidKeyed = Boolean(ctx.servNextCheckEnabled);
    const keyedAutonomyDiag = buildKeyedAutonomyDiag({
      keyed,
      mintSaidKeyed,
      autonomousServ,
      source: live.source,
      failureDiag: live.failureDiag,
      clampDiag: live.clampDiag,
    });

    const loop = decideFindNextCheckLoop({
      keyed,
      autonomousServ,
      chosenId: executedId,
      research: replan.research,
      rematchOk,
      needBeforeFp: fingerprintNeed(ctx.need),
      needAfterFp: fingerprintNeed(updated.need),
      listingsBeforeFp: fingerprintListings(ctx.listings),
      listingsAfterFp: fingerprintListings(updated.listings),
      // Count per-car check progress when SERV chose it, or when this hop is the
      // intentional free consistency drain. A SERV timeout/fallback must not look
      // like new evidence and keep the paid loop going.
      freeGovBeforeFp:
        live.source === "serv" || servDecision.reason === "consistency_deterministic_drain"
          ? `${fingerprintFreeGovReceipts(priorReceipts)}|${carCheckFingerprint(priorCarChecks)}`
          : fingerprintFreeGovReceipts(priorReceipts),
      freeGovAfterFp:
        live.source === "serv" || servDecision.reason === "consistency_deterministic_drain"
          ? `${fingerprintFreeGovReceipts(freeGovReceipts)}|${carCheckFingerprint(carChecks)}`
          : fingerprintFreeGovReceipts(freeGovReceipts),
      shortlistCount: shortlistAfter.length,
      remainingActionableCount,
      remainingFreeGovCount,
      consistencyStillOpen: consistencyStillOpenAfter,
    });
    const loopSettled = !loop.continue && remainingFreeGovCount === 0 && !consistencyStillOpenAfter;
    if (loopSettled !== (updated.loopSettled === true)) {
      updated.loopSettled = loopSettled;
      await updateFindSearchContext(deps.kv, updated, { loopSettled });
    }

    const payload: FindNextCheckOrchestratorOk = {
      ok: true,
      searchContextToken: updated.token,
      source: live.source,
      autonomousServ,
      replay,
      chosenId: executedId,
      servNote: live.servNote,
      replan,
      research: replan.research,
      allowedChecks: live.allowedChecks,
      compare: live.compare,
      shortlist: shortlistAfter,
      proofs: live.proofs,
      failureDiag: live.failureDiag,
      clampDiag: live.clampDiag,
      keyedAutonomyDiag,
      honesty:
        (live.source === "serv"
          ? `${live.honesty}${freeEvidenceNote ? ` ${freeEvidenceNote}` : ""}`
          : `${live.honesty} Source=deterministic_fallback — not autonomous SERV.${keyedAutonomyDiag.configHint ? ` ${keyedAutonomyDiag.configHint}` : ""}${freeEvidenceNote ? ` ${freeEvidenceNote}` : ""}`) +
        (overrodeUserAction && executedId !== live.chosenId
          ? " A paid or manual step was suggested. Free public checks still run."
          : ""),
      rematch,
      needAfter: replan.need,
      appliedCheckIds: appliedNext,
      freeGovReceipts,
      freeEvidenceNote,
      riskCoverage,
      freeGovCoverage: coverageAfter,
      bestDeal,
      loop,
      servPaidCalls: nextPaidCalls,
      servInvokeReason: servDecision.reason,
      decisionLog,
      baseline: bestDeal.baseline,
      carChecks,
      targetKeys,
    };

    if (claimId) {
      await completeFindNextCheckAction(
        deps.kv,
        identity,
        claimId,
        publicResultPayload(payload),
        servHttpAttempts,
      );
    }

    return payload;
  } catch (err) {
    if (claimId) await releaseFindNextCheckAction(deps.kv, identity, claimId);
    throw err;
  }
}
