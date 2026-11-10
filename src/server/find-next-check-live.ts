/**
 * Authenticated Find next-check live path (t320 residual).
 *
 * Gap closed here: proposeFindNextChecks + applyFindNextCheck were offline/UI-only;
 * this module calls SERV profile `find_next_check`, clamps to the code allowlist,
 * applies the check in code, and signals when a real rematch (/api/match) is needed.
 *
 * No invented TCO/history/best-car. Fail closed to deterministic allowlist[0] when
 * SERV is unavailable (profile fallback). Does not invent listings — rematch uses
 * existing /api/match + Autodev guards.
 */

import type { DecisionProof } from "@/domain/decision-note";
import {
  compareObservedModels,
  type ObservedListingRow,
} from "@/domain/find-model-observe";
import {
  buildFindNextCheckChoiceSchema,
  clampFindNextCheckChoice,
  clampFindNextCheckTargetKeys,
  parseFindNextCheckChoice,
  type FindNextCheckClampDiag,
} from "@/domain/find-next-check-choice";
import {
  allowedFindNextCheckIds,
  proposeFindNextChecks,
  type FindNextCheck,
  type FindNextCheckId,
} from "@/domain/find-next-checks";
import {
  applyFindNextCheck,
  buildGroundedShortlist,
  type FindReplan,
  type FindSearchRefine,
  type GroundedShortlistEntry,
} from "@/domain/find-path";
import {
  softPrefGapsFromText,
  validateNeed,
  type SoftPrefGap,
  type StructuredNeed,
} from "@/domain/need";
import type { FuelFact } from "@/domain/types";
import { redactUntrustedPromptValue, screenUserInput } from "@/domain/screen";
import {
  buildDecisionProofRecord,
  FIND_NEXT_CHECK_RUBRIC_ID,
  type DecisionProofRecord,
} from "@/domain/decision-proof-record";
import { runServ, type ServProof } from "@/server/serv";
import {
  classifyServPlannerFailure,
  type ServResponseFailureDiag,
} from "@/server/serv/response-failure";

export type FindNextCheckLiveDeps = {
  servKey?: string | null;
  servModel?: string | null;
  servBaseUrl?: string | null;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  /**
   * When true, skip the paid SERV HTTP call and use the deterministic allowlist
   * preferred id (free-gov drain / paid-call cap). Still a real next-check hop.
   */
  skipServ?: boolean;
  /** Why SERV was skipped — logged in honesty / diag; never secrets. */
  skipServReason?: string | null;
};

export type FindNextCheckLiveOk = {
  ok: true;
  source: "serv" | "deterministic_fallback";
  allowedChecks: FindNextCheck[];
  chosenId: FindNextCheckId;
  /** Server-clamped car keys (max 3, subset of the top 5). Null when SERV sent none. */
  targetKeys: string[];
  servNote: string | null;
  replan: FindReplan;
  compare: ReturnType<typeof compareObservedModels>;
  shortlist: GroundedShortlistEntry[];
  /** Client must POST /api/match with need+refine when true — real replacement search. */
  research: boolean;
  proofs: DecisionProof[];
  failureDiag: ServResponseFailureDiag | null;
  /** Bounded clamp diagnostics — raw denied id + allowlist (no secrets / no prose dump). */
  clampDiag: FindNextCheckClampDiag | null;
  honesty: string;
  /** One lemonless.decision_proof.v1 row for this hop (ok, skipped, or failed). */
  proofRecords: DecisionProofRecord[];
};

export type FindNextCheckLiveErr = {
  ok: false;
  status: number;
  error: string;
  message: string;
};

function sanitizeServNote(note: string, factsBlob: string): string {
  // Only keep notes that do not invent dollar amounts absent from facts.
  if (!note) return "";
  const dollar = /\$\s?\d/.test(note);
  if (dollar && !factsBlob.includes("$") && !/\$\d/.test(factsBlob)) {
    return "";
  }
  return note.slice(0, 280);
}

/**
 * Build allowlist facts, optionally ask SERV find_next_check, clamp, apply in code.
 */
export async function runFindNextCheckLive(
  body: {
    need?: unknown;
    listings?: ObservedListingRow[];
    refine?: FindSearchRefine;
    fuelsByModelKey?: Record<string, FuelFact | null>;
    /** Already-applied check ids this session — avoid identical re-apply loops. */
    appliedCheckIds?: string[];
    /** Prior free public NHTSA receipts (planner facts — immutable). */
    freeGovBrief?: {
      count: number;
      toolIds: string[];
      statuses: string[];
      summaries: string[];
      cards?: Array<{
        make: string;
        model: string;
        year: number;
        status: string;
        summary: string;
        scope: string;
        sourceUrl?: string | null;
        toolId?: string;
        factNotes: string[];
        honesty: string;
        riskFacts?: Record<string, unknown> | null;
      }>;
    } | null;
    /** Per-tool MMY coverage — keeps free_gov_* allowlisted while unchecked remain. */
    freeGovCoverage?: {
      listingMmyCount: number;
      recalls: { checked: number; unchecked: number; eligible: number };
      safety: { checked: number; unchecked: number; eligible: number };
      vpic: { checked: number; unchecked: number; eligible: number };
      anyUnchecked: boolean;
      note: string;
    } | null;
    /** Current top 5, ranked with the same market pool as the pick the shopper sees. */
    top5?: Array<{
      key: string;
      rank: number;
      label: string;
      score: number;
      gapToAhead: number;
      unknowns: string[];
    }>;
    consistencyStillOpen?: boolean;
    /**
     * When set, the choice schema only allows these keys.
     * Used for one close-call tie-break among the tied cars.
     */
    tieBreakKeys?: string[];
  },
  deps: FindNextCheckLiveDeps = {},
): Promise<FindNextCheckLiveOk | FindNextCheckLiveErr> {
  const validated = validateNeed(body.need ?? {});
  if (!validated.ok) {
    const message = validated.issues.map((i) => i.message).join("; ") || "Invalid need.";
    return { ok: false, status: 400, error: "invalid_need", message };
  }
  const need = validated.need;
  const screened = screenUserInput(need.note || need.mode);
  if (!screened.ok) {
    return { ok: false, status: 400, error: "rejected_input", message: screened.reason };
  }

  const listings = Array.isArray(body.listings) ? body.listings : [];
  const softGaps: SoftPrefGap[] = softPrefGapsFromText(need.note);
  const compare = compareObservedModels(listings, body.fuelsByModelKey ?? {});
  const listingsHaveVin = listings.some(
    (l) => typeof (l as { vin?: string | null }).vin === "string" &&
      String((l as { vin?: string | null }).vin).trim().length >= 11,
  );
  const appliedCheckIds = (body.appliedCheckIds ?? []).filter((id) => typeof id === "string");
  const allowedChecks = proposeFindNextChecks({
    need,
    softGaps,
    observedListingCount: listings.length,
    observedModelCount: compare.length,
    emptyInventory: listings.length === 0,
    appliedCheckIds,
    listingsHaveVin,
    freeGovCoverage: body.freeGovCoverage ?? null,
    consistencyStillOpen: body.consistencyStillOpen,
  });
  const allowedIds = allowedFindNextCheckIds(allowedChecks);
  if (allowedIds.length === 0) {
    return {
      ok: false,
      status: 422,
      error: "no_allowed_checks",
      message: "No allowlisted next checks for this need/inventory state.",
    };
  }

  const preferred = allowedChecks[0]!;

  const facts = {
    allowedChecks: allowedIds,
    observedListingCount: listings.length,
    observedModelCount: compare.length,
    softGapIds: softGaps.map((g) => g.id),
    emptyInventory: listings.length === 0,
    budgetKnown: need.budgetKnown,
    yearMin: need.yearMin,
    yearMax: need.yearMax,
    milesMax: need.milesMax,
    conditionPriority: need.conditionPriority,
    distanceMiles: need.distanceMiles,
    zipPresent: Boolean(need.zip),
    listingsHaveVin,
    appliedCheckIds,
    freeGovEvidence: body.freeGovBrief ?? { count: 0, toolIds: [], statuses: [], summaries: [] },
    freeGovCoverage: body.freeGovCoverage ?? null,
    top5: body.top5 ?? [],
    tieBreak: body.tieBreakKeys && body.tieBreakKeys.length > 0
      ? {
          keys: body.tieBreakKeys,
          note: "Code already names the current leader as the best choice. These cars are very close. Choose the one allowlisted check most likely to separate them. targetKeys must be copied from these keys.",
        }
      : null,
    freeGovHonesty:
      "Free public government inputs only: recalls/complaints (year/make/model), VIN decode, NCAP safety ratings, FuelEconomy.gov fuel estimates (ambiguous configs = labeled range), plus a per-car compare of the listing with that VIN decode and with listing-says accidents, owners, rental use, and days listed. Not NMVTIS/title. Empty or failed lookups are not a clean zero. Best-deal scores are computed in code. Choose the check most likely to change the pick using top5 gaps and unknowns.",
  };
  const safeFacts = redactUntrustedPromptValue(facts);
  const factsBlob = JSON.stringify(safeFacts);
  const user = JSON.stringify({
    purpose: "find_next_check",
    facts: safeFacts,
    // Untrusted shopper note — already screened. Listing fields inside facts are redacted too.
    shopperNote: screened.text.slice(0, 500),
  });

  const proofs: ServProof[] = [];
  let source: "serv" | "deterministic_fallback" = "deterministic_fallback";
  let chosenId: FindNextCheckId = preferred.id;
  let targetKeys: string[] = [];
  let servNote: string | null = null;
  let failureDiag: ServResponseFailureDiag | null = null;
  let clampDiag: FindNextCheckClampDiag | null = null;

  // Request schema enum = live allowlist only (not the full catalog) so constrained
  // decoding cannot emit schema-valid / allowlist-invalid ids (PR80 Scenario2).
  const top5Keys = (body.top5 ?? []).map((row) => row.key);
  const tieBreakKeys = [...new Set((body.tieBreakKeys ?? []).map((key) => key.trim()).filter(Boolean))].slice(0, 5);
  const schemaKeys = tieBreakKeys.length > 0 ? tieBreakKeys : top5Keys;
  const choiceSchema = buildFindNextCheckChoiceSchema(allowedIds, schemaKeys);

  const key = deps.servKey?.trim() || null;
  if (key && deps.skipServ) {
    // Bounded free-gov drain / paid-call cap — keep SERV autonomy real on other hops.
    source = "deterministic_fallback";
    chosenId = preferred.id;
    servNote = null;
    failureDiag = null;
  } else if (key) {
    const result = await runServ(
      "find_next_check",
      { user, facts: safeFacts },
      {
        apiKey: key,
        baseUrl: deps.servBaseUrl ?? undefined,
        model: deps.servModel ?? undefined,
        fetch: deps.fetchImpl,
        env: deps.env,
        jsonSchemaOverride: choiceSchema,
      },
    );
    proofs.push(result.proof);
    if (!result.ok) {
      failureDiag =
        result.failureDiag ??
        classifyServPlannerFailure({
          httpOk: false,
          status: result.status,
          text: "",
        });
      // status 0 = abort/timeout/network before HTTP — call it out (no secrets).
      if (!result.failureDiag && result.status === 0) {
        failureDiag = {
          category: "http_error",
          reasonCode: "serv_timeout_or_network",
          honesty:
            "SERV find_next_check did not complete before profile timeout / network abort. Deterministic allowlist applied.",
          fields: {
            contentIsNull: true,
            contentEmpty: true,
            contentBytes: 0,
            refusalFieldPresent: false,
            refusalFieldBytes: null,
            finishReason: null,
            hasUsageObject: false,
          },
          usage: null,
        };
      }
      // Profile fallback: deterministic allowlist — not silent invent.
      source = "deterministic_fallback";
    } else {
      const parsed = parseFindNextCheckChoice(result.text);
      if (!parsed) {
        failureDiag = classifyServPlannerFailure({
          httpOk: true,
          status: result.rawStatus,
          text: "",
          parseKind: "invalid_json",
        });
        source = "deterministic_fallback";
      } else {
        clampDiag = clampFindNextCheckChoice(parsed.checkId, allowedIds);
        if (!clampDiag.clamped) {
          // Unknown / off-allowlist id → preferred deterministic; surface denied id (bounded).
          source = "deterministic_fallback";
          servNote = null;
          const denied = clampDiag.deniedCheckId ?? "<unknown>";
          const allow = clampDiag.allowlistIds.join(",");
          failureDiag = {
            category: "schema_mismatch",
            reasonCode: "check_id_not_in_allowlist",
            honesty: `SERV checkId denied=${denied} allowlist=[${allow}] alias=${clampDiag.aliasApplied ?? "none"} — deterministic preferred applied. No invent.`,
            fields: {
              contentIsNull: false,
              contentEmpty: false,
              contentBytes: result.text.length,
              refusalFieldPresent: false,
              refusalFieldBytes: null,
              finishReason: null,
              hasUsageObject: false,
            },
            usage: null,
          };
        } else {
          chosenId = clampDiag.clamped;
          targetKeys = clampFindNextCheckTargetKeys(parsed.targetKeys, schemaKeys);
          servNote = sanitizeServNote(parsed.note, factsBlob) || null;
          source = "serv";
        }
      }
    }
  }

  const refine = body.refine ?? {};
  const replan = applyFindNextCheck(need, chosenId, refine);
  const shortlist = buildGroundedShortlist(replan.need, listings, body.fuelsByModelKey ?? {});

  const skipBit =
    key && deps.skipServ
      ? ` Paid SERV skipped this hop (${deps.skipServReason ?? "bounded_free_gov_drain"}) — deterministic free public batch only.`
      : "";
  const recordedAt = new Date().toISOString();
  const lastProof = proofs[proofs.length - 1] ?? null;
  const proofRecords: DecisionProofRecord[] = [
    key && deps.skipServ
      ? buildDecisionProofRecord({
          purpose: "find_next_check",
          rubricId: FIND_NEXT_CHECK_RUBRIC_ID,
          status: "skipped_call_cap",
          recordedAt,
          inputs: {
            chosenId,
            skipServReason: deps.skipServReason ?? "bounded_free_gov_drain",
          },
          detail: `SERV not invoked this hop (${deps.skipServReason ?? "bounded_free_gov_drain"}) — deterministic free public check ${chosenId}.`,
        })
      : source === "serv"
        ? buildDecisionProofRecord({
            purpose: "find_next_check",
            rubricId: FIND_NEXT_CHECK_RUBRIC_ID,
            status: "ok",
            recordedAt,
            responseId: typeof lastProof?.openserv?.id === "string" ? lastProof.openserv.id : null,
            model: lastProof?.modelReported || lastProof?.modelRequested || deps.servModel || null,
            inputs: { chosenId, targetKeys, note: servNote },
            verdict: chosenId,
            rawResponse:
              typeof lastProof?.openserv?.output_text === "string" ? lastProof.openserv.output_text : null,
            detail: servNote,
          })
        : buildDecisionProofRecord({
            purpose: "find_next_check",
            rubricId: FIND_NEXT_CHECK_RUBRIC_ID,
            status: key ? "failed" : "skipped_no_key",
            recordedAt,
            responseId: null,
            model: lastProof?.modelReported || lastProof?.modelRequested || deps.servModel || null,
            inputs: {
              chosenId,
              failureCategory: failureDiag?.category ?? null,
              reasonCode: failureDiag?.reasonCode ?? null,
            },
            detail:
              failureDiag?.honesty ||
              (key
                ? `Deterministic fallback chose ${chosenId} after SERV did not return an allowlisted check.`
                : "SERV_API_KEY not configured — deterministic allowlist only."),
            rawResponse:
              typeof lastProof?.openserv?.output_text === "string" ? lastProof.openserv.output_text : null,
          }),
  ];
  return {
    ok: true,
    source,
    allowedChecks,
    chosenId,
    targetKeys,
    servNote,
    replan,
    compare,
    shortlist,
    research: replan.research,
    proofs,
    failureDiag,
    clampDiag,
    proofRecords,
    honesty:
      source === "serv"
        ? "SERV chose an allowlisted check and optional target cars. Apply/replan is code-owned. Rematch uses NEW need — no invented listings, TCO, or history."
        : key && deps.skipServ
          ? `Deterministic free public check (${deps.skipServReason ?? "bounded_free_gov_drain"}) — SERV was not called this hop.${skipBit}`
          : `deterministic_fallback (not autonomous SERV): code allowlist apply only.${skipBit}`,
  };
}
