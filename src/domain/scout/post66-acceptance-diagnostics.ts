/**
 * Offline acceptance diagnostics for post-PR66 live-cycle audits (t299).
 *
 * Read-only analysis of sanitized run snapshots. Does NOT fix product behavior
 * (price floor policy, evidence retention, reject/replan). Exists so an
 * independent reviewer can score a writer's forthcoming fix against observed
 * holes without reconstructing missing raw planner text or declaring a model winner.
 *
 * Counts here are toolOutcomes / result fields — not upstream SERV HTTP attempts
 * and not billing receipts.
 */

import { MIN_USABLE_ASKING_PRICE_USD } from "./asking-price";

const GOV_TOOL_IDS = new Set([
  "evidence.gov_vpic",
  "evidence.gov_recalls",
  "evidence.gov_safety",
  "evidence.gov_fuel",
]);

/** Suspicious band just above the usable floor — seller claims may still be placeholders. */
export const NEAR_FLOOR_SELLER_CLAIM_USD = {
  minInclusive: MIN_USABLE_ASKING_PRICE_USD,
  /** Exclusive upper bound for the near-floor diagnostic band (not a product policy). */
  maxExclusive: MIN_USABLE_ASKING_PRICE_USD + 100,
} as const;

export type AcceptanceToolOutcome = {
  toolId: string;
  vin?: string | null;
  ok: boolean;
  status?: string;
};

export type AcceptanceSelectedCandidate = {
  vin: string;
  priceUsd: number | null;
  priceSource?: string[];
  evidenceKeys: string[];
  withheld: boolean;
  claimsSafeBuy: boolean;
  claimsVerifiedProfit: boolean;
};

export type AcceptanceProvenanceRow = {
  state: string;
  reason?: string | null;
  toolId?: string | null;
};

export type AcceptanceRunSnapshot = {
  /** When present, tool executions actually recorded (not URL-only). */
  toolOutcomes: AcceptanceToolOutcome[];
  selected: AcceptanceSelectedCandidate[];
  provenance?: AcceptanceProvenanceRow[];
  inventorySearchCount?: number;
  tokensRecorded?: boolean;
  rawPlannerActionsPresent?: boolean;
};

export type AcceptanceHoleId =
  | "gov_evidence_retention_gap"
  | "no_reject_or_replace"
  | "single_inventory_no_replan"
  | "near_floor_seller_claims"
  | "completion_by_candidate_cap"
  | "raw_planner_absent"
  | "tokens_unrecorded"
  | "claims_honesty_ok";

export type AcceptanceHole = {
  id: AcceptanceHoleId;
  severity: "blocker_for_product_acceptance" | "diagnostic_gap" | "preserved_safeguard";
  /** True when this hole is in scope for PR68 compare/parse diagnostics. */
  addressedByParseDiagnosticsPr68: boolean;
  summary: string;
  counts?: Record<string, number>;
};

export type AcceptanceDiagnosticsReport = {
  schemaVersion: "post66-acceptance-diagnostics/v1";
  holes: AcceptanceHole[];
  dispositionMix: {
    inventorySearch: number;
    govToolsOk: number;
    govToolsFailedOrEmpty: number;
    reject: number;
    replace: number;
    gatesVerifyAcquire: number;
    listingNormalizeAcquire: number;
  };
  /** Explicit: toolOutcome counts ≠ SERV HTTP attempts / billing. */
  countersAreNotHttpOrBilling: true;
  modelWinnerClaimForbidden: true;
};

function countTool(outcomes: AcceptanceToolOutcome[], id: string): number {
  return outcomes.filter((o) => o.toolId === id).length;
}

/**
 * Analyze a sanitized post-run snapshot for product-acceptance holes.
 * Offline / fixture only — never opens listings or calls providers.
 */
export function diagnosePost66Acceptance(snapshot: AcceptanceRunSnapshot): AcceptanceDiagnosticsReport {
  const outcomes = snapshot.toolOutcomes ?? [];
  const selected = snapshot.selected ?? [];
  const holes: AcceptanceHole[] = [];

  const govOk = outcomes.filter((o) => GOV_TOOL_IDS.has(o.toolId) && o.ok);
  const govBad = outcomes.filter(
    (o) => GOV_TOOL_IDS.has(o.toolId) && (!o.ok || o.status === "empty" || o.status === "failed"),
  );

  // Gov success for a VIN but investigation evidenceKeys lack any evidence.gov_* key.
  let retentionMisses = 0;
  const vinsWithGovOk = new Set(
    govOk.map((o) => o.vin).filter((v): v is string => typeof v === "string" && Boolean(v)),
  );
  for (const vin of vinsWithGovOk) {
    const cand = selected.find((s) => s.vin === vin);
    if (!cand) continue;
    const hasGovKey = cand.evidenceKeys.some((k) => k.startsWith("evidence.gov_"));
    if (!hasGovKey) retentionMisses += 1;
  }
  if (retentionMisses > 0 || (govOk.length > 0 && selected.every((s) => !s.evidenceKeys.some((k) => k.startsWith("evidence.gov_"))))) {
    holes.push({
      id: "gov_evidence_retention_gap",
      severity: "blocker_for_product_acceptance",
      addressedByParseDiagnosticsPr68: false,
      summary:
        "Successful evidence.gov_* toolOutcomes exist, but selected/investigation evidenceKeys lack gov facts — retention/packet gap (writer root-cause scope).",
      counts: {
        govToolOutcomesOk: govOk.length,
        selectedWithGovOkButNoGovEvidenceKey: retentionMisses || selected.length,
      },
    });
  }

  const reject = countTool(outcomes, "candidate.reject");
  const replace = countTool(outcomes, "candidate.replace");
  if (reject === 0 && replace === 0) {
    holes.push({
      id: "no_reject_or_replace",
      severity: "blocker_for_product_acceptance",
      addressedByParseDiagnosticsPr68: false,
      summary:
        "No candidate.reject or candidate.replace outcomes — select/check/acquire path only; model quality of reject/replace not demonstrated.",
      counts: { reject, replace },
    });
  }

  const inventorySearch =
    typeof snapshot.inventorySearchCount === "number"
      ? snapshot.inventorySearchCount
      : countTool(outcomes, "inventory.search");
  if (inventorySearch <= 1) {
    holes.push({
      id: "single_inventory_no_replan",
      severity: "blocker_for_product_acceptance",
      addressedByParseDiagnosticsPr68: false,
      summary:
        "At most one inventory.search — no evidence-led search revision/replan demonstrated (tool-count ≠ selection quality).",
      counts: { inventorySearch },
    });
  }

  const nearFloor = selected.filter((s) => {
    if (s.priceUsd == null || !Number.isFinite(s.priceUsd)) return false;
    return (
      s.priceUsd >= NEAR_FLOOR_SELLER_CLAIM_USD.minInclusive &&
      s.priceUsd < NEAR_FLOOR_SELLER_CLAIM_USD.maxExclusive
    );
  });
  if (nearFloor.length > 0) {
    holes.push({
      id: "near_floor_seller_claims",
      severity: "blocker_for_product_acceptance",
      addressedByParseDiagnosticsPr68: false,
      summary: `Seller-claim prices in [${NEAR_FLOOR_SELLER_CLAIM_USD.minInclusive}, ${NEAR_FLOOR_SELLER_CLAIM_USD.maxExclusive}) passed the usable floor mechanically — suspicious band, not verified purchase price (no seller-page verify tool in this snapshot).`,
      counts: { nearFloorSelected: nearFloor.length, selected: selected.length },
    });
  }

  const capFinalize = (snapshot.provenance ?? []).some(
    (p) =>
      (p.state === "finalizing" || p.state === "completed") &&
      typeof p.reason === "string" &&
      /candidate cap reached/i.test(p.reason),
  );
  if (capFinalize) {
    holes.push({
      id: "completion_by_candidate_cap",
      severity: "diagnostic_gap",
      addressedByParseDiagnosticsPr68: false,
      summary:
        "Completion triggered by candidate cap / finalize path — not an observed SERV final recommendation with stored finish_reason.",
    });
  }

  if (snapshot.rawPlannerActionsPresent !== true) {
    holes.push({
      id: "raw_planner_absent",
      severity: "diagnostic_gap",
      addressedByParseDiagnosticsPr68: true,
      summary:
        "Full raw planner actions/reasons/citations absent from this snapshot. Compare harness (PR68) adds sanitized echoes for future compare rows only — production run receipts still need writer/parent capture policy.",
    });
  }

  if (snapshot.tokensRecorded !== true) {
    holes.push({
      id: "tokens_unrecorded",
      severity: "diagnostic_gap",
      addressedByParseDiagnosticsPr68: true,
      summary:
        "Tokens not recorded on this run snapshot (cost unknown). PR68 normalizeCompareUsage treats all-zero compare usage as unknown, not free.",
    });
  }

  const honestyOk =
    selected.length > 0 &&
    selected.every((s) => s.withheld === true && s.claimsSafeBuy === false && s.claimsVerifiedProfit === false);
  if (honestyOk) {
    holes.push({
      id: "claims_honesty_ok",
      severity: "preserved_safeguard",
      addressedByParseDiagnosticsPr68: false,
      summary:
        "All selected candidates withheld with claimsSafeBuy=false and claimsVerifiedProfit=false — honesty safeguards preserved (not product acceptance).",
      counts: { selected: selected.length },
    });
  }

  return {
    schemaVersion: "post66-acceptance-diagnostics/v1",
    holes,
    dispositionMix: {
      inventorySearch,
      govToolsOk: govOk.length,
      govToolsFailedOrEmpty: govBad.length,
      reject,
      replace,
      gatesVerifyAcquire: countTool(outcomes, "gates.verify"),
      listingNormalizeAcquire: countTool(outcomes, "listing.normalize"),
    },
    countersAreNotHttpOrBilling: true,
    modelWinnerClaimForbidden: true,
  };
}

export function productAcceptanceBlockers(report: AcceptanceDiagnosticsReport): AcceptanceHole[] {
  return report.holes.filter((h) => h.severity === "blocker_for_product_acceptance");
}
