/**
 * Free public deep-checks for Resale triage targets.
 * Code runs the lookups; SERV only chose which VINs/checks to run.
 * Results feed the decision journal — never invents recalls or decode data.
 */

import type { ResaleCandidatePnl } from "@/domain/resale-pnl";
import type { ResaleDecisionJournal } from "@/domain/resale-decision-journal";
import { appendJournalStep } from "@/domain/resale-decision-journal";
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

/**
 * Run allowlisted free checks on triage-selected candidates.
 * `price_comps` is already code-owned from P&L — journaled as available evidence only.
 */
export async function runResaleDeepChecks(input: {
  candidates: ResaleCandidatePnl[];
  checkIds: string[];
  journal: ResaleDecisionJournal;
  fetchImpl?: typeof fetch;
  nowIso?: string;
}): Promise<ResaleDeepCheckResult> {
  const recordedAt = input.nowIso ?? new Date().toISOString();
  let journal = input.journal;
  const findings: ResaleDeepCheckFinding[] = [];
  const rejectedVins = new Map<string, string>();
  const riskByVin = new Map<string, number>(input.candidates.map((c) => [c.vin, 1]));
  const gov: GovDeps = { fetch: input.fetchImpl ?? fetch };
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

  for (const item of input.candidates) {
    if (checks.has("vin_decode") && item.vin.length === 17) {
      const decode = await decodeVin(item.vin, gov);
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
        riskByVin.set(item.vin, (riskByVin.get(item.vin) ?? 1) * 0.9);
        journal = appendJournalStep(journal, {
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
        journal = appendJournalStep(journal, {
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

    if (checks.has("recalls")) {
      const recalls = await recallsFor(item.listing.make, item.listing.model, item.listing.year, gov);
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
        journal = appendJournalStep(journal, {
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
          rejectedVins.set(item.vin, detail);
          riskByVin.set(item.vin, 0);
          journal = appendJournalStep(journal, {
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
          riskByVin.set(item.vin, (riskByVin.get(item.vin) ?? 1) * (recalls.records.length > 0 ? 0.9 : 1));
          journal = appendJournalStep(journal, {
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

    if (checks.has("complaints")) {
      const complaints = await complaintsFor(item.listing.make, item.listing.model, item.listing.year, gov);
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
        journal = appendJournalStep(journal, {
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
        journal = appendJournalStep(journal, {
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
      if (!known) riskByVin.set(item.vin, (riskByVin.get(item.vin) ?? 1) * 0.92);
      journal = appendJournalStep(journal, {
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
