/**
 * Free public deep-checks for Resale triage targets.
 * Code runs the lookups; SERV only chose which VINs/checks to run.
 * Results feed the decision journal — never invents recalls or decode data.
 */

import type { ResaleCandidatePnl } from "@/domain/resale-pnl";
import type { ResaleDecisionJournal, ResaleJournalStep } from "@/domain/resale-decision-journal";
import { appendJournalStep } from "@/domain/resale-decision-journal";
import {
  RESALE_SERV_SAFETY_MS,
  RESALE_STAGE_BUDGET_MS,
  RESALE_TIME_BUDGET_SKIP,
  type ResaleDeadline,
} from "@/domain/resale-deadline";
import { complaintsFor, decodeVin, recallsFor, type GovDeps } from "@/io/gov";

export type ResaleDeepCheckFinding = {
  vin: string;
  checkId: "vin_decode" | "recalls" | "complaints" | "price_comps" | "history";
  ok: boolean;
  /** Reject this candidate from the shortlist when true (e.g. parkIt). */
  reject: boolean;
  /** Risk haircut applied to ranking score (0–1 multiplier remaining). */
  riskMultiplier: number;
  detail: string;
  evidenceId: string;
};

export type ResaleDeepCheckResult = {
  findings: ResaleDeepCheckFinding[];
  /** VINs rejected with stated reasons. */
  rejectedVins: Map<string, string>;
  /** Per-VIN risk multiplier (default 1). */
  riskByVin: Map<string, number>;
  journal: ResaleDecisionJournal;
};

function carLabel(item: ResaleCandidatePnl): string {
  const l = item.listing;
  return `${l.year} ${l.make} ${l.model}`.trim();
}

type VinCheckBundle = {
  findings: ResaleDeepCheckFinding[];
  rejectedReason: string | null;
  riskMul: number;
  steps: Array<Omit<ResaleJournalStep, "id"> & { id?: string }>;
};

async function deepCheckOneVin(input: {
  item: ResaleCandidatePnl;
  checks: Set<string>;
  gov: GovDeps;
  recordedAt: string;
  signal: AbortSignal;
}): Promise<VinCheckBundle> {
  const { item, checks, gov, recordedAt, signal } = input;
  const findings: ResaleDeepCheckFinding[] = [];
  const steps: Array<Omit<ResaleJournalStep, "id"> & { id?: string }> = [];
  let riskMul = 1;
  let rejectedReason: string | null = null;

  if (signal.aborted) {
    return { findings, rejectedReason, riskMul, steps };
  }

  if (checks.has("vin_decode") && item.vin.length === 17) {
    const decode = await decodeVin(item.vin, gov);
    if (signal.aborted) return { findings, rejectedReason, riskMul, steps };
    if (!decode) {
      findings.push({
        vin: item.vin,
        checkId: "vin_decode",
        ok: false,
        reject: false,
        riskMultiplier: 0.9,
        detail: "VIN decode unavailable from NHTSA vPIC for this run.",
        evidenceId: `check:vin_decode:${item.vin}`,
      });
      riskMul *= 0.9;
      steps.push({
        kind: "deep_check",
        actor: "code",
        decided: `VIN decode unavailable for ${carLabel(item)}`,
        why: "NHTSA vPIC did not return a usable decode. History availability stays unknown.",
        inputsUsed: [`vin:${item.vin}`, `check:vin_decode`],
        changed: null,
        model: null,
        responseId: null,
        recordedAt,
        rejected: null,
      });
    } else {
      findings.push({
        vin: item.vin,
        checkId: "vin_decode",
        ok: true,
        reject: false,
        riskMultiplier: 1,
        detail: `VIN decode OK: ${decode.year ?? "?"} ${decode.make ?? "?"} ${decode.model ?? "?"}.`,
        evidenceId: `check:vin_decode:${item.vin}`,
      });
      steps.push({
        kind: "deep_check",
        actor: "code",
        decided: `VIN decode confirmed for ${carLabel(item)}`,
        why: `vPIC returned year/make/model for the listing VIN.`,
        inputsUsed: [`vin:${item.vin}`, `check:vin_decode`],
        changed: null,
        model: null,
        responseId: null,
        recordedAt,
        rejected: null,
      });
    }
  }

  if (checks.has("recalls") && !signal.aborted) {
    const recalls = await recallsFor(item.listing.make, item.listing.model, item.listing.year, gov);
    if (signal.aborted) return { findings, rejectedReason, riskMul, steps };
    if (!recalls.available) {
      findings.push({
        vin: item.vin,
        checkId: "recalls",
        ok: false,
        reject: false,
        riskMultiplier: 0.95,
        detail: "NHTSA recalls unavailable for this make/model/year on this run.",
        evidenceId: `check:recalls:${item.vin}`,
      });
      steps.push({
        kind: "deep_check",
        actor: "code",
        decided: `Recalls lookup unavailable for ${carLabel(item)}`,
        why: "NHTSA recallsByVehicle did not return a usable payload.",
        inputsUsed: [`vin:${item.vin}`, `check:recalls`],
        changed: null,
        model: null,
        responseId: null,
        recordedAt,
        rejected: null,
      });
    } else {
      const parkIt = recalls.records.some((r) => r.parkIt);
      const detail = parkIt
        ? `NHTSA lists a park-it recall campaign for this make/model/year (${recalls.records.length} campaign(s)).`
        : `NHTSA recalls available: ${recalls.records.length} campaign(s); none marked park-it.`;
      findings.push({
        vin: item.vin,
        checkId: "recalls",
        ok: true,
        reject: parkIt,
        riskMultiplier: parkIt ? 0 : recalls.records.length > 0 ? 0.9 : 1,
        detail,
        evidenceId: `check:recalls:${item.vin}`,
      });
      if (parkIt) {
        rejectedReason = detail;
        riskMul = 0;
        steps.push({
          kind: "reject",
          actor: "code",
          decided: `Rejected ${carLabel(item)} — park-it recall`,
          why: detail,
          inputsUsed: [`vin:${item.vin}`, `check:recalls`],
          changed: `Removed ${item.vin} from shortlist`,
          model: null,
          responseId: null,
          recordedAt,
          rejected: null,
        });
      } else {
        riskMul *= recalls.records.length > 0 ? 0.9 : 1;
        steps.push({
          kind: "deep_check",
          actor: "code",
          decided: `Recalls checked for ${carLabel(item)}`,
          why: detail,
          inputsUsed: [`vin:${item.vin}`, `check:recalls`],
          changed: null,
          model: null,
          responseId: null,
          recordedAt,
          rejected: null,
        });
      }
    }
  }

  if (checks.has("complaints") && !signal.aborted) {
    const complaints = await complaintsFor(item.listing.make, item.listing.model, item.listing.year, gov);
    if (signal.aborted) return { findings, rejectedReason, riskMul, steps };
    if (!complaints.available || complaints.count == null) {
      findings.push({
        vin: item.vin,
        checkId: "complaints",
        ok: false,
        reject: false,
        riskMultiplier: 1,
        detail: "NHTSA complaints count unavailable for this make/model/year.",
        evidenceId: `check:complaints:${item.vin}`,
      });
      steps.push({
        kind: "deep_check",
        actor: "code",
        decided: `Complaints lookup unavailable for ${carLabel(item)}`,
        why: "NHTSA complaints endpoint did not return a usable count.",
        inputsUsed: [`vin:${item.vin}`, `check:complaints`],
        changed: null,
        model: null,
        responseId: null,
        recordedAt,
        rejected: null,
      });
    } else {
      findings.push({
        vin: item.vin,
        checkId: "complaints",
        ok: true,
        reject: false,
        riskMultiplier: 1,
        detail: `NHTSA complaint count for this make/model/year: ${complaints.count}.`,
        evidenceId: `check:complaints:${item.vin}`,
      });
      steps.push({
        kind: "deep_check",
        actor: "code",
        decided: `Complaints checked for ${carLabel(item)}`,
        why: `Count ${complaints.count} from NHTSA (make/model/year, not VIN-specific).`,
        inputsUsed: [`vin:${item.vin}`, `check:complaints`],
        changed: null,
        model: null,
        responseId: null,
        recordedAt,
        rejected: null,
      });
    }
  }

  // History availability is honest-unknown unless listing already carries accidentCount.
  if (checks.has("history") || checks.has("history_availability")) {
    const known = item.listing.accidentCount != null;
    findings.push({
      vin: item.vin,
      checkId: "history",
      ok: known,
      reject: false,
      riskMultiplier: known ? 1 : 0.92,
      detail: known
        ? `Listing reports accidentCount=${item.listing.accidentCount}.`
        : "Title/accident history availability: unknown on this listing — verify before buying.",
      evidenceId: `check:history:${item.vin}`,
    });
    if (!known) riskMul *= 0.92;
    steps.push({
      kind: "deep_check",
      actor: "code",
      decided: known ? `History field present for ${carLabel(item)}` : `History unknown for ${carLabel(item)}`,
      why: known
        ? `Listing accidentCount=${item.listing.accidentCount}.`
        : "No title/accident history feed on this listing — left as unknown.",
      inputsUsed: [`vin:${item.vin}`, `check:history`],
      changed: null,
      model: null,
      responseId: null,
      recordedAt,
      rejected: null,
    });
  }

  return { findings, rejectedReason, riskMul, steps };
}

/**
 * Run allowlisted free checks on triage-selected candidates.
 * `price_comps` is already code-owned from P&L — journaled as available evidence only.
 * Network VIN checks run in parallel under an 8s stage cap (deadline-aware) and abort on the cap.
 */
export async function runResaleDeepChecks(input: {
  candidates: ResaleCandidatePnl[];
  checkIds: string[];
  journal: ResaleDecisionJournal;
  fetchImpl?: typeof fetch;
  nowIso?: string;
  deadline?: ResaleDeadline;
  /** Cap for the network deep-check wave (default 8s). */
  stageCapMs?: number;
}): Promise<ResaleDeepCheckResult> {
  const recordedAt = input.nowIso ?? new Date().toISOString();
  let journal = input.journal;
  const findings: ResaleDeepCheckFinding[] = [];
  const rejectedVins = new Map<string, string>();
  const riskByVin = new Map<string, number>(input.candidates.map((c) => [c.vin, 1]));
  const checks = new Set(input.checkIds.filter(Boolean));

  // Always treat price/comps as already computed by code for every candidate.
  if (checks.has("price_comps") || checks.size === 0) {
    for (const item of input.candidates) {
      const profitBit =
        item.profitMidUsd != null
          ? `$${item.profitMidUsd.toLocaleString("en-US")}${
              item.profitScopeLabel ? ` ${item.profitScopeLabel}` : ""
            }`
          : "unknown";
      const rankingNote =
        !item.salesTaxKnown && item.rankingProfitMidUsd != null
          ? ` Ranking note: uses $${item.rankingProfitMidUsd.toLocaleString("en-US")} after the max statewide-base tax haircut so unknown-tax cars are not favored.`
          : "";
      const detail =
        item.compCount >= 3
          ? `Price/comps already computed: ${item.compCount} similar listings, mid profit ${profitBit}.${rankingNote}`
          : `Price/comps thin: only ${item.compCount} similar listings — confidence stays Low.`;
      findings.push({
        vin: item.vin,
        checkId: "price_comps",
        ok: item.compCount >= 3,
        reject: false,
        riskMultiplier: item.compCount >= 5 ? 1 : item.compCount >= 3 ? 0.85 : 0.6,
        detail,
        evidenceId: `check:price_comps:${item.vin}`,
      });
      riskByVin.set(item.vin, (riskByVin.get(item.vin) ?? 1) * (item.compCount >= 5 ? 1 : item.compCount >= 3 ? 0.85 : 0.6));
    }
    journal = appendJournalStep(journal, {
      kind: "deep_check",
      actor: "code",
      decided: "Ran price/comps check from code P&L (no new provider call)",
      why: "Similar-listing fair value and profit were already computed for the shortlist.",
      inputsUsed: input.candidates.map((c) => `pnl:${c.vin}`),
      changed: null,
      model: null,
      responseId: null,
      recordedAt,
      rejected: null,
    });
  }

  const needsNetwork =
    checks.has("vin_decode") || checks.has("recalls") || checks.has("complaints") || checks.has("history") || checks.has("history_availability");
  if (!needsNetwork || input.candidates.length === 0) {
    return { findings, rejectedVins, riskByVin, journal };
  }

  const stageCap = input.stageCapMs ?? RESALE_STAGE_BUDGET_MS.deepCheck;
  if (input.deadline && !input.deadline.allow(Math.min(2_000, stageCap))) {
    journal = appendJournalStep(journal, {
      kind: "fallback",
      actor: "code",
      decided: `Deep-check ${RESALE_TIME_BUDGET_SKIP}`,
      why: `Wall-clock budget remaining ${input.deadline.remainingMs()}ms — keeping price/comps only.`,
      inputsUsed: input.candidates.map((c) => `vin:${c.vin}`),
      changed: null,
      model: null,
      responseId: null,
      recordedAt,
      rejected: null,
    });
    // History-only sync path so journal still notes unknowns without network.
    for (const item of input.candidates) {
      if (!(checks.has("history") || checks.has("history_availability"))) continue;
      const known = item.listing.accidentCount != null;
      findings.push({
        vin: item.vin,
        checkId: "history",
        ok: known,
        reject: false,
        riskMultiplier: known ? 1 : 0.92,
        detail: known
          ? `Listing reports accidentCount=${item.listing.accidentCount}.`
          : "Title/accident history availability: unknown on this listing — verify before buying.",
        evidenceId: `check:history:${item.vin}`,
      });
      if (!known) riskByVin.set(item.vin, (riskByVin.get(item.vin) ?? 1) * 0.92);
    }
    return { findings, rejectedVins, riskByVin, journal };
  }

  const capMs = Math.min(
    stageCap,
    input.deadline ? Math.max(500, input.deadline.remainingMs() - RESALE_SERV_SAFETY_MS) : stageCap,
  );
  const stageAbort = new AbortController();
  const timer = setTimeout(() => stageAbort.abort(), capMs);
  const gov: GovDeps = { fetch: input.fetchImpl ?? fetch, signal: stageAbort.signal };

  try {
    const bundles = await Promise.all(
      input.candidates.map((item) =>
        deepCheckOneVin({
          item,
          checks,
          gov,
          recordedAt,
          signal: stageAbort.signal,
        }),
      ),
    );
    for (let i = 0; i < input.candidates.length; i += 1) {
      const item = input.candidates[i]!;
      const bundle = bundles[i]!;
      for (const finding of bundle.findings) findings.push(finding);
      if (bundle.rejectedReason) rejectedVins.set(item.vin, bundle.rejectedReason);
      riskByVin.set(item.vin, (riskByVin.get(item.vin) ?? 1) * bundle.riskMul);
      for (const step of bundle.steps) {
        journal = appendJournalStep(journal, step);
      }
    }
    if (stageAbort.signal.aborted) {
      journal = appendJournalStep(journal, {
        kind: "fallback",
        actor: "code",
        decided: `Deep-check stage aborted (${RESALE_TIME_BUDGET_SKIP})`,
        why: `Stage cap ${capMs}ms fired — in-flight NHTSA fetches were aborted.`,
        inputsUsed: input.candidates.map((c) => `vin:${c.vin}`),
        changed: null,
        model: null,
        responseId: null,
        recordedAt,
        rejected: null,
      });
    }
  } finally {
    clearTimeout(timer);
    if (!stageAbort.signal.aborted) stageAbort.abort();
  }

  return { findings, rejectedVins, riskByVin, journal };
}

/** Re-rank by risk-adjusted mid profit after deep-checks (uses ranking profit, not displayed). */
export function rankByRiskAdjustedProfit(
  candidates: ResaleCandidatePnl[],
  riskByVin: Map<string, number>,
): ResaleCandidatePnl[] {
  return [...candidates].sort((a, b) => {
    const aMid = a.rankingProfitMidUsd ?? a.profitMidUsd ?? Number.NEGATIVE_INFINITY;
    const bMid = b.rankingProfitMidUsd ?? b.profitMidUsd ?? Number.NEGATIVE_INFINITY;
    const aScore = aMid * (riskByVin.get(a.vin) ?? 1);
    const bScore = bMid * (riskByVin.get(b.vin) ?? 1);
    return bScore - aScore;
  });
}
