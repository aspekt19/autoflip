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
  type FindNextCheckLoopDisposition,
} from "@/domain/find-next-check-loop";
import { buildGroundedShortlistWithRisk, type FindSearchRefine } from "@/domain/find-path";
import { proposeFindNextChecks } from "@/domain/find-next-checks";
import {
  mergeFreeGovReceiptsByMmy,
  riskCoverageHonesty,
} from "@/domain/find-risk-evidence";
import {
  countNonFreeAllowlistChoices,
  fingerprintBestDealShortlist,
  shouldInvokeServForFindNextCheck,
} from "@/domain/find-serv-budget";
import { softPrefGapsFromText, type StructuredNeed } from "@/domain/need";
import type { ScoutFreeGovPort } from "@/domain/scout/free-gov";
import type { Kv } from "@/io/kv";
import {
  appliedFingerprint,
  claimFindNextCheckAction,
  completeFindNextCheckAction,
  logFindNextCheckServSpend,
  releaseFindNextCheckAction,
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
  });
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
  let claimId: string | null = null;
  let replay = false;

  if (keyed) {
    const claim = await claimFindNextCheckAction(deps.kv, identity);
    if (claim.kind === "in_progress") {
      return {
        ok: false,
        status: 409,
        error: "next_check_in_progress",
        message: "That next-check is already running for this search — wait or retry shortly.",
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
    const priorProposed = proposeFindNextChecks({
      need: ctx.need,
      softGaps: softGapsPrior,
      observedListingCount: ctx.listings.length,
      observedModelCount: new Set(ctx.listings.map((l) => `${l.make}|${l.model}`)).size,
      emptyInventory: ctx.listings.length === 0,
      appliedCheckIds: ctx.appliedCheckIds,
      listingsHaveVin: listingsHaveVinPrior,
      freeGovCoverage: priorCoverage,
    });
    const priorAllowedIds = priorProposed.map((c) => c.id);
    const priorFreeGovCount = priorAllowedIds.filter((id) => isFindFreeGovCheckId(id)).length;
    const priorBestDeal = selectBestDealOnEvidence({
      need: ctx.need,
      listings: ctx.listings,
      receipts: priorReceipts,
    });
    const shortlistFp = fingerprintBestDealShortlist(priorBestDeal.ranked);
    const paidSoFar = ctx.servPaidCalls ?? 0;
    const servDecision = shouldInvokeServForFindNextCheck({
      paidCallsSoFar: paidSoFar,
      remainingFreeGovCount: priorFreeGovCount,
      nonFreeChoiceCount: countNonFreeAllowlistChoices(priorAllowedIds),
      shortlistFp,
      lastServShortlistFp: ctx.lastServShortlistFp ?? null,
      neverCalledServ: paidSoFar === 0,
    });
    const live = await runFindNextCheckLive(
      {
        need: ctx.need,
        listings: ctx.listings,
        refine: ctx.refine,
        appliedCheckIds: ctx.appliedCheckIds,
        freeGovBrief: freeGovReceiptsBrief(priorReceipts),
        freeGovCoverage: priorCoverage,
      },
      {
        servKey: deps.servKey,
        servModel: deps.servModel,
        servBaseUrl: deps.servBaseUrl,
        fetchImpl: deps.fetchImpl,
        env: deps.env,
        skipServ: keyed && !servDecision.invoke,
        skipServReason: servDecision.reason,
      },
    );

    if (!live.ok) {
      if (claimId) await releaseFindNextCheckAction(deps.kv, identity, claimId);
      return live;
    }

    const servHttpAttempts = live.proofs.length > 0 && keyed && servDecision.invoke ? 1 : 0;
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

    const appliedNext = [...ctx.appliedCheckIds, live.chosenId];
    let rematch: FindNextCheckOrchestratorOk["rematch"] = null;
    let listingsAfter = ctx.listings;
    let compsPoolAfter: FindSearchListingFact[] = ctx.compsPool ?? ctx.listings;
    let refineAfter = live.replan.refine;
    let rematchOk: boolean | null = null;
    let freeGovReceipts = priorReceipts;
    let freeEvidenceNote: string | null = null;

    if (live.research && deps.runMatch) {
      // CRITICAL: rematch uses NEW need from apply — never pre-apply / stale UI years.
      const matchResult = await deps.runMatch({
        need: live.replan.need,
        refine: live.replan.refine,
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
    } else if (live.research && !deps.runMatch) {
      rematch = null; // client must rematch with returned needAfter only
      rematchOk = null;
    }

    // Free public government tools — autonomous, no Report credit, reuses Scout free-gov port.
    if (live.replan.freeEvidence) {
      const executed = await executeFindFreeGovCheck({
        checkId: live.chosenId,
        listings: listingsAfter,
        priorReceipts,
        gov: deps.freeGovPort,
        shopperNote: live.replan.need.note,
      });
      if (executed) {
        // Dedup by checkId+year/make/model so cached re-runs cannot append duplicate receipts / fake cycles.
        if (executed.receipts.length > 0) {
          freeGovReceipts = mergeFreeGovReceiptsByMmy(priorReceipts, executed.receipts);
        }
        freeEvidenceNote = executed.note;
        live.replan = {
          ...live.replan,
          note: `${live.replan.note} ${executed.note}`.trim(),
        };
      }
    }

    const nextPaidCalls = nextPaidCallsPreview;
    const updated: FindSearchContextRecord = await updateFindSearchContext(deps.kv, ctx, {
      need: live.replan.need,
      refine: refineAfter,
      listings: listingsAfter,
      compsPool: compsPoolAfter,
      appliedCheckIds: appliedNext,
      freeGovReceipts,
      servPaidCalls: nextPaidCalls,
      lastServShortlistFp:
        servHttpAttempts > 0 ? shortlistFp : (ctx.lastServShortlistFp ?? null),
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
    const bestDeal = selectBestDealOnEvidence({
      need: updated.need,
      listings: updated.listings,
      receipts: freeGovReceipts,
      marketPool: marketPoolFromListingFacts(updated.compsPool ?? updated.listings),
    });
    const shortlistAfter = shortlistPack.entries;
    const riskCoverage = shortlistPack.coverage;
    const softGaps = softPrefGapsFromText(updated.need.note);
    const listingsHaveVin = updated.listings.some(
      (l) => typeof l.vin === "string" && l.vin.trim().length >= 11,
    );
    const coverageAfter = freeGovToolCoverage(updated.listings, freeGovReceipts);
    const remainingProposed = proposeFindNextChecks({
      need: updated.need,
      softGaps,
      observedListingCount: updated.listings.length,
      observedModelCount: new Set(updated.listings.map((l) => `${l.make}|${l.model}`)).size,
      emptyInventory: updated.listings.length === 0,
      appliedCheckIds: appliedNext,
      listingsHaveVin,
      freeGovCoverage: coverageAfter,
    });
    const remainingActionableCount = countRemainingAutomaticChecks(
      remainingProposed.map((c) => c.id),
      appliedNext,
    );
    const remainingFreeGovCount = remainingProposed.filter((c) =>
      isFindFreeGovCheckId(c.id),
    ).length;

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
      chosenId: live.chosenId,
      research: live.research,
      rematchOk,
      needBeforeFp: fingerprintNeed(ctx.need),
      needAfterFp: fingerprintNeed(updated.need),
      listingsBeforeFp: fingerprintListings(ctx.listings),
      listingsAfterFp: fingerprintListings(updated.listings),
      freeGovBeforeFp: fingerprintFreeGovReceipts(priorReceipts),
      freeGovAfterFp: fingerprintFreeGovReceipts(freeGovReceipts),
      shortlistCount: shortlistAfter.length,
      remainingActionableCount,
      remainingFreeGovCount,
    });

    const payload: FindNextCheckOrchestratorOk = {
      ok: true,
      searchContextToken: updated.token,
      source: live.source,
      autonomousServ,
      replay,
      chosenId: live.chosenId,
      servNote: live.servNote,
      replan: live.replan,
      research: live.research,
      allowedChecks: live.allowedChecks,
      compare: live.compare,
      shortlist: shortlistAfter,
      proofs: live.proofs,
      failureDiag: live.failureDiag,
      clampDiag: live.clampDiag,
      keyedAutonomyDiag,
      honesty:
        live.source === "serv"
          ? `${live.honesty}${freeEvidenceNote ? ` ${freeEvidenceNote}` : ""}`
          : `${live.honesty} Source=deterministic_fallback — not autonomous SERV.${keyedAutonomyDiag.configHint ? ` ${keyedAutonomyDiag.configHint}` : ""}${freeEvidenceNote ? ` ${freeEvidenceNote}` : ""}`,
      rematch,
      needAfter: live.replan.need,
      appliedCheckIds: appliedNext,
      freeGovReceipts,
      freeEvidenceNote,
      riskCoverage,
      freeGovCoverage: coverageAfter,
      bestDeal,
      loop,
      servPaidCalls: nextPaidCalls,
      servInvokeReason: servDecision.reason,
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
