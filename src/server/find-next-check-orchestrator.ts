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
import {
  countRemainingAutomaticChecks,
  decideFindNextCheckLoop,
  fingerprintListings,
  fingerprintNeed,
  type FindNextCheckLoopDisposition,
} from "@/domain/find-next-check-loop";
import { buildGroundedShortlist, type FindSearchRefine } from "@/domain/find-path";
import { proposeFindNextChecks } from "@/domain/find-next-checks";
import { softPrefGapsFromText, type StructuredNeed } from "@/domain/need";
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
  listingsFromMatchDirections,
  loadFindSearchContext,
  updateFindSearchContext,
  type FindSearchContextRecord,
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
  honesty: string;
  /** Rematch payload when research — always built from NEW need after apply. */
  rematch: {
    ok: boolean;
    status: number;
    body: MatchRematchBody;
  } | null;
  needAfter: StructuredNeed;
  appliedCheckIds: string[];
  /** Ordinary UI auto-continues when continue=true (no hidden step quota). */
  loop: FindNextCheckLoopDisposition;
};

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
    shortlist: ok.shortlist,
    failureDiag: ok.failureDiag
      ? {
          category: ok.failureDiag.category,
          reasonCode: ok.failureDiag.reasonCode,
          refusalFieldBytes: ok.failureDiag.fields.refusalFieldBytes,
          usagePresent: Boolean(ok.failureDiag.usage),
        }
      : null,
    honesty: ok.honesty,
    rematch: ok.rematch,
    needAfter: ok.needAfter,
    appliedCheckIds: ok.appliedCheckIds,
    loop: ok.loop,
    proofs: ok.proofs,
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
    const live = await runFindNextCheckLive(
      {
        need: ctx.need,
        listings: ctx.listings,
        refine: ctx.refine,
        appliedCheckIds: ctx.appliedCheckIds,
      },
      {
        servKey: deps.servKey,
        servModel: deps.servModel,
        servBaseUrl: deps.servBaseUrl,
        fetchImpl: deps.fetchImpl,
        env: deps.env,
      },
    );

    if (!live.ok) {
      if (claimId) await releaseFindNextCheckAction(deps.kv, identity, claimId);
      return live;
    }

    const servHttpAttempts = live.proofs.length > 0 && keyed ? 1 : 0;
    if (claimId && servHttpAttempts > 0) {
      await logFindNextCheckServSpend(deps.kv, identity, claimId, {
        profile: "find_next_check",
        httpAttempts: servHttpAttempts,
        source: live.source,
      });
    }

    const appliedNext = [...ctx.appliedCheckIds, live.chosenId];
    let rematch: FindNextCheckOrchestratorOk["rematch"] = null;
    let listingsAfter = ctx.listings;
    let refineAfter = live.replan.refine;
    let rematchOk: boolean | null = null;

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
      }
    } else if (live.research && !deps.runMatch) {
      rematch = null; // client must rematch with returned needAfter only
      rematchOk = null;
    }

    const updated: FindSearchContextRecord = await updateFindSearchContext(deps.kv, ctx, {
      need: live.replan.need,
      refine: refineAfter,
      listings: listingsAfter,
      appliedCheckIds: appliedNext,
    });

    // Shortlist + remaining checks from POST-apply / POST-rematch evidence.
    const shortlistAfter = buildGroundedShortlist(updated.need, updated.listings);
    const softGaps = softPrefGapsFromText(updated.need.note);
    const remainingProposed = proposeFindNextChecks({
      need: updated.need,
      softGaps,
      observedListingCount: updated.listings.length,
      observedModelCount: new Set(updated.listings.map((l) => `${l.make}|${l.model}`)).size,
      emptyInventory: updated.listings.length === 0,
    });
    const remainingActionableCount = countRemainingAutomaticChecks(
      remainingProposed.map((c) => c.id),
      appliedNext,
    );

    const loop = decideFindNextCheckLoop({
      keyed,
      autonomousServ: live.source === "serv",
      chosenId: live.chosenId,
      research: live.research,
      rematchOk,
      needBeforeFp: fingerprintNeed(ctx.need),
      needAfterFp: fingerprintNeed(updated.need),
      listingsBeforeFp: fingerprintListings(ctx.listings),
      listingsAfterFp: fingerprintListings(updated.listings),
      shortlistCount: shortlistAfter.length,
      remainingActionableCount,
    });

    const payload: FindNextCheckOrchestratorOk = {
      ok: true,
      searchContextToken: updated.token,
      source: live.source,
      autonomousServ: live.source === "serv",
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
      honesty:
        live.source === "serv"
          ? live.honesty
          : `${live.honesty} Source=deterministic_fallback — not autonomous SERV.`,
      rematch,
      needAfter: live.replan.need,
      appliedCheckIds: appliedNext,
      loop,
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
