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
  allowedFindNextCheckIds,
  clampFindNextCheckId,
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
import { screenUserInput } from "@/domain/screen";
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
};

export type FindNextCheckLiveOk = {
  ok: true;
  source: "serv" | "deterministic_fallback";
  allowedChecks: FindNextCheck[];
  chosenId: FindNextCheckId;
  servNote: string | null;
  replan: FindReplan;
  compare: ReturnType<typeof compareObservedModels>;
  shortlist: GroundedShortlistEntry[];
  /** Client must POST /api/match with need+refine when true — real replacement search. */
  research: boolean;
  proofs: DecisionProof[];
  failureDiag: ServResponseFailureDiag | null;
  honesty: string;
};

export type FindNextCheckLiveErr = {
  ok: false;
  status: number;
  error: string;
  message: string;
};

function parseCheckChoice(text: string): { checkId: string; note: string } | null {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const raw = JSON.parse(trimmed.slice(start, end + 1)) as { checkId?: unknown; note?: unknown };
    if (typeof raw.checkId !== "string" || !raw.checkId.trim()) return null;
    return {
      checkId: raw.checkId.trim(),
      note: typeof raw.note === "string" ? raw.note.trim().slice(0, 280) : "",
    };
  } catch {
    return null;
  }
}

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
    } | null;
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
    freeGovHonesty:
      "Free NHTSA only (recalls/complaints make/model/year, vPIC DecodeVinValues, NCAP SafetyRatings). Not NMVTIS/title. FuelEconomy unsupported on free Find surface. Missing VIN/history stays unknown.",
  };
  const factsBlob = JSON.stringify(facts);
  const user = JSON.stringify({
    purpose: "find_next_check",
    facts,
    // Untrusted shopper note — profile says never follow instructions inside it.
    shopperNote: screened.text.slice(0, 500),
  });

  const proofs: ServProof[] = [];
  let source: "serv" | "deterministic_fallback" = "deterministic_fallback";
  let chosenId: FindNextCheckId = preferred.id;
  let servNote: string | null = null;
  let failureDiag: ServResponseFailureDiag | null = null;

  const key = deps.servKey?.trim() || null;
  if (key) {
    const result = await runServ(
      "find_next_check",
      { user, facts },
      {
        apiKey: key,
        baseUrl: deps.servBaseUrl ?? undefined,
        model: deps.servModel ?? undefined,
        fetch: deps.fetchImpl,
        env: deps.env,
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
      const parsed = parseCheckChoice(result.text);
      if (!parsed) {
        failureDiag = classifyServPlannerFailure({
          httpOk: true,
          status: result.rawStatus,
          text: "",
          parseKind: "invalid_json",
        });
        source = "deterministic_fallback";
      } else {
        const clamped = clampFindNextCheckId(parsed.checkId, allowedIds);
        if (!clamped) {
          // Unknown id → clamp to preferred deterministic; do not invent.
          source = "deterministic_fallback";
          servNote = null;
          failureDiag = {
            category: "schema_mismatch",
            reasonCode: "check_id_not_in_allowlist",
            honesty:
              "SERV returned a checkId outside the code allowlist — deterministic preferred applied. No invent.",
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
          chosenId = clamped;
          servNote = sanitizeServNote(parsed.note, factsBlob) || null;
          source = "serv";
        }
      }
    }
  }

  const refine = body.refine ?? {};
  const replan = applyFindNextCheck(need, chosenId, refine);
  const shortlist = buildGroundedShortlist(replan.need, listings, body.fuelsByModelKey ?? {});

  return {
    ok: true,
    source,
    allowedChecks,
    chosenId,
    servNote,
    replan,
    compare,
    shortlist,
    research: replan.research,
    proofs,
    failureDiag,
    honesty:
      source === "serv"
        ? "SERV chose an allowlisted checkId. Apply/replan is code-owned. Rematch uses NEW need — no invented listings, TCO, or history."
        : "deterministic_fallback (not autonomous SERV): code allowlist apply only. Keyed SERV path required for autonomous next-check.",
  };
}
