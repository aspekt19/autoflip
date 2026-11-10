/**
 * Honest truncation labels + free-terminal policy (PR follow-up after #85).
 * Scenario2: 14 MMY / 6-row silent cap / compare unchanged while free_gov_safety remains.
 */
import { describe, expect, it } from "vitest";
import {
  FREE_GOV_BRIEF_CARD_PREVIEW,
  freeGovReceiptsBrief,
  freeGovToolCoverage,
  type FindFreeGovReceipt,
} from "./find-free-gov";
import {
  FREE_GOV_UI_DETAIL_PREVIEW,
  formatFreeGovReceiptsForUi,
  type FreeGovReceiptUiRow,
} from "./find-free-gov-format";
import { decideFindNextCheckLoop } from "./find-next-check-loop";
import { proposeFindNextChecks } from "./find-next-checks";
import {
  riskFactsFromPacket,
  type FreeGovRiskFacts,
} from "./find-risk-evidence";
import type { FreeGovEvidencePacket } from "./scout/free-gov";
import { softPrefGapsFromText } from "./need";

function recallPacket(opts?: {
  recallCount?: number;
  campaigns?: Array<{ campaignNumber: string; parkIt?: boolean; parkOutSide?: boolean }>;
  parkIt?: boolean;
  parkOutside?: boolean;
}): FreeGovEvidencePacket {
  const campaigns =
    opts?.campaigns ??
    Array.from({ length: opts?.recallCount ?? 1 }, (_, i) => ({
      campaignNumber: `20V00${i}`,
      parkIt: false,
      parkOutSide: false,
      component: "X",
      summary: "t",
    }));
  const recallCount = opts?.recallCount ?? campaigns.length;
  const parkIt = opts?.parkIt ?? false;
  const parkOutside = opts?.parkOutside ?? false;
  return {
    toolId: "evidence.gov_recalls",
    status: "ok",
    cached: false,
    fetchedAt: "t0",
    scope: "nhtsa_recalls_by_vehicle",
    url: "https://api.nhtsa.gov/recalls/recallsByVehicle?make=Mazda&model=CX-5&modelYear=2016",
    timeoutMs: 8000,
    rateNote: "",
    limitsNote: "Max 8 campaign summaries retained.",
    facts: [
      {
        key: "evidence.gov_recalls",
        value: {
          status: "ok",
          recallCount,
          recallsAvailable: true,
          parkIt,
          parkOutside,
          campaigns: campaigns.map((c) => ({
            campaignNumber: c.campaignNumber,
            parkIt: c.parkIt ?? false,
            parkOutSide: c.parkOutSide ?? false,
            component: "X",
            summary: "t",
          })),
          complaintsAvailable: true,
          complaintCount: 10,
          url: "https://api.nhtsa.gov/recalls/recallsByVehicle?make=Mazda&model=CX-5&modelYear=2016",
          vinOpenRecalls: null,
        },
        kind: "verified",
        source: "gov",
        note: "nhtsa",
      },
    ],
    summary: `NHTSA recalls ${recallCount} campaign(s); complaints=10; parkIt=${parkIt}; parkOutside=${parkOutside}.`,
    outcomeOk: true,
    outcomeStatus: "success",
    outcomeCapability: "supported_executed",
  };
}

function receipt(
  year: number,
  make: string,
  model: string,
  opts?: { status?: FindFreeGovReceipt["status"]; checkId?: FindFreeGovReceipt["checkId"]; riskFacts?: FreeGovRiskFacts | null },
): FindFreeGovReceipt {
  const checkId = opts?.checkId ?? "free_gov_recalls";
  const toolId =
    checkId === "free_gov_safety"
      ? "evidence.gov_safety"
      : checkId === "free_gov_vpic"
        ? "evidence.gov_vpic"
        : "evidence.gov_recalls";
  return {
    checkId,
    toolId,
    status: opts?.status ?? "ok",
    summary: `NHTSA recalls for ${year} ${make} ${model}`,
    scope: "mmy",
    limitsNote: "",
    vin: null,
    make,
    model,
    year,
    fetchedAt: "t0",
    cached: false,
    sourceUrl: `https://api.nhtsa.gov/recalls/recallsByVehicle?make=${make}&model=${model}&modelYear=${year}`,
    factNotes: [],
    riskFacts: opts?.riskFacts ?? null,
    fuelEvidence: null,
    honesty: "year/make/model ≠ VIN",
  };
}

const MMY14: Array<{ make: string; model: string; year: number }> = [
  { make: "Honda", model: "CR-V", year: 2015 },
  { make: "Hyundai", model: "Tucson", year: 2016 },
  { make: "Hyundai", model: "Tucson", year: 2017 },
  { make: "Hyundai", model: "Tucson", year: 2018 },
  { make: "Kia", model: "Sportage", year: 2019 },
  { make: "Mazda", model: "CX-5", year: 2014 },
  { make: "Mazda", model: "CX-5", year: 2015 },
  { make: "Mazda", model: "CX-5", year: 2016 },
  { make: "Toyota", model: "RAV4", year: 2015 },
  { make: "Toyota", model: "RAV4", year: 2016 },
  { make: "Ford", model: "Escape", year: 2014 },
  { make: "Ford", model: "Escape", year: 2015 },
  { make: "Nissan", model: "Rogue", year: 2017 },
  { make: "Chevrolet", model: "Equinox", year: 2018 },
];

describe("honest receipt inspectability (14 MMY / no silent 6-cap)", () => {
  it("formats all 14 receipts individually — preview cap only with honest footer", () => {
    const rows: FreeGovReceiptUiRow[] = MMY14.map((m) => ({
      checkId: "free_gov_recalls",
      toolId: "evidence.gov_recalls",
      status: "ok",
      summary: `NHTSA recalls 0 campaign(s); complaints=1`,
      vin: null,
      make: m.make,
      model: m.model,
      year: m.year,
      sourceUrl: `https://api.nhtsa.gov/recalls/recallsByVehicle?make=${m.make}&model=${m.model}&modelYear=${m.year}`,
      riskFacts: {
        parkIt: false,
        parkOutside: false,
        campaignNumbers: [],
        campaignCountReported: 0,
        complaintCount: 1,
      },
    }));
    expect(FREE_GOV_UI_DETAIL_PREVIEW).toBe(6);
    const all = formatFreeGovReceiptsForUi(rows);
    expect(all).toHaveLength(14);
    // Buyer-visible lines: human source label, never raw API URLs / format=json.
    expect(all.every((line) => /NHTSA recalls \(U\.S\. government\)/.test(line))).toBe(true);
    expect(all.every((line) => !/api\.nhtsa\.gov|format=json|src=https?:\/\//i.test(line))).toBe(true);

    const preview = formatFreeGovReceiptsForUi(rows, { previewMax: FREE_GOV_UI_DETAIL_PREVIEW });
    expect(preview).toHaveLength(FREE_GOV_UI_DETAIL_PREVIEW + 1);
    expect(preview[preview.length - 1]).toMatch(/showing 6 of 14/);
    expect(preview[preview.length - 1]).toMatch(/not silent clearance/i);
  });

  it("labels campaign counts honestly for buyers when several campaigns are on file", () => {
    // Mimic Scenario2: summary/count says 5; only 4 IDs retained in riskFacts.
    const facts = riskFactsFromPacket(
      recallPacket({
        recallCount: 5,
        campaigns: [
          { campaignNumber: "16V644000" },
          { campaignNumber: "16V203000" },
          { campaignNumber: "16V054000" },
          { campaignNumber: "16E002000" },
        ],
      }),
      { make: "Mazda", model: "CX-5", year: 2016 },
    );
    expect(facts.campaignCountReported).toBe(5);
    expect(facts.campaignNumbers).toHaveLength(4);

    const line = formatFreeGovReceiptsForUi([
      {
        toolId: "evidence.gov_recalls",
        status: "ok",
        summary: "NHTSA recalls 5 campaign(s); complaints=10",
        make: "Mazda",
        model: "CX-5",
        year: 2016,
        sourceUrl: facts.sourceUrl,
        riskFacts: {
          parkIt: facts.parkIt,
          parkOutside: facts.parkOutside,
          campaignNumbers: facts.campaignNumbers,
          campaignCountReported: facts.campaignCountReported,
          complaintCount: facts.complaintCount,
        },
      },
    ])[0]!;
    expect(line).toMatch(/5 recall campaign/);
    expect(line).toMatch(/NHTSA recalls \(U\.S\. government\)/);
    expect(line).not.toMatch(/api\.nhtsa\.gov|format=json/i);
  });

  it("SERV brief keeps allCoverage for 14 while cards preview is capped + labeled", () => {
    const receipts = MMY14.map((m) => receipt(m.year, m.make, m.model));
    const brief = freeGovReceiptsBrief(receipts);
    expect(FREE_GOV_BRIEF_CARD_PREVIEW).toBe(6);
    expect(brief.count).toBe(14);
    expect(brief.cards).toHaveLength(6);
    expect(brief.cardsTruncated).toBe(true);
    expect(brief.truncationNote).toMatch(/show 6 of 14/);
    expect(brief.allCoverage).toHaveLength(14);
    expect(brief.allCoverage.every((c) => c.sourceUrl && c.status && c.toolId)).toBe(true);
    expect(brief.summaries).toHaveLength(14);
  });
});

describe("tool-specific coverage — failed ≠ clearance", () => {
  it("error/unavailable attempts count as checked for that tool only — not fleet clearance", () => {
    const listings = MMY14.map((m) => ({
      ...m,
      priceUsd: 12_000,
      miles: 80_000,
    }));
    const receipts: FindFreeGovReceipt[] = [
      receipt(2015, "Honda", "CR-V", { status: "error" }),
      receipt(2016, "Hyundai", "Tucson", { status: "unavailable" }),
      receipt(2019, "Kia", "Sportage", { status: "ok" }),
    ];
    const cov = freeGovToolCoverage(listings, receipts);
    expect(cov.listingMmyCount).toBe(14);
    expect(cov.recalls.checked).toBe(3);
    expect(cov.recalls.unchecked).toBe(11);
    expect(cov.safety.checked).toBe(0);
    expect(cov.safety.unchecked).toBe(14);
    expect(cov.anyUnchecked).toBe(true);
    expect(cov.note).toMatch(/recalls/i);
    // Safety still fully open — error recalls ≠ safety clearance.
    const proposed = proposeFindNextChecks({
      need: {
        yearMin: null,
        yearMax: null,
        milesMax: null,
        budgetKnown: true,
        budgetUsd: 20_000,
        distanceMiles: 50,
        zip: "68114",
        conditionPriority: "inspection_first",
        mode: "personal",
        note: "suv under 20k reliable",
        yearBandResolved: false,
        milesCapResolved: false,
      } as never,
      softGaps: softPrefGapsFromText("reliable condition history"),
      observedListingCount: listings.length,
      observedModelCount: 8,
      emptyInventory: false,
      appliedCheckIds: ["free_gov_recalls"],
      listingsHaveVin: false,
      freeGovCoverage: cov,
    });
    const ids = proposed.map((p) => p.id);
    expect(ids).toContain("free_gov_recalls");
    expect(ids).toContain("free_gov_safety");
    expect(ids).not.toContain("free_gov_vpic"); // no VIN eligible
  });
});

describe("free-terminal policy — compare/no-op must not finish while free safety remains", () => {
  const loopBase = {
    keyed: true,
    autonomousServ: true,
    research: false,
    rematchOk: null as boolean | null,
    needBeforeFp: "same",
    needAfterFp: "same",
    listingsBeforeFp: "same",
    listingsAfterFp: "same",
    freeGovBeforeFp: "fp14",
    freeGovAfterFp: "fp14",
    shortlistCount: 3,
    remainingActionableCount: 2,
  };

  it("noop compare continues when free_gov_safety still actionable", () => {
    const d = decideFindNextCheckLoop({
      ...loopBase,
      chosenId: "compare_observed_asks",
      remainingFreeGovCount: 1,
    });
    expect(d.continue).toBe(true);
    expect(d.reason).toBe("remaining_free_checks");
    expect(d.detail).toMatch(/free public/i);
  });

  it("new evidence progress still continues as evidence_changed_replan", () => {
    const d = decideFindNextCheckLoop({
      ...loopBase,
      chosenId: "free_gov_recalls",
      freeGovBeforeFp: "fp3",
      freeGovAfterFp: "fp6",
      remainingFreeGovCount: 2,
      remainingActionableCount: 3,
    });
    expect(d.continue).toBe(true);
    expect(d.reason).toBe("evidence_changed_replan");
  });

  it("exhausted free terminal: unchanged compare with no remaining free → stop", () => {
    const d = decideFindNextCheckLoop({
      ...loopBase,
      chosenId: "compare_observed_asks",
      remainingFreeGovCount: 0,
      remainingActionableCount: 0,
    });
    expect(d.continue).toBe(false);
    expect(["unchanged_state", "grounded_stop", "no_remaining_research_checks"]).toContain(d.reason);
  });

  it("no-available-VIN: vPIC not forced; safety still free-terminal when open", () => {
    const listings = MMY14.map((m) => ({ ...m, priceUsd: 10_000, miles: 90_000, vin: null }));
    const recallDone = MMY14.map((m) => receipt(m.year, m.make, m.model));
    const cov = freeGovToolCoverage(listings, recallDone);
    expect(cov.recalls.unchecked).toBe(0);
    expect(cov.vpic.eligible).toBe(0);
    expect(cov.safety.unchecked).toBe(14);
    const proposed = proposeFindNextChecks({
      need: {
        yearMin: null,
        yearMax: null,
        milesMax: null,
        budgetKnown: true,
        budgetUsd: 20_000,
        distanceMiles: 50,
        zip: "68114",
        conditionPriority: "inspection_first",
        mode: "personal",
        note: "crossover",
        yearBandResolved: false,
        milesCapResolved: false,
      } as never,
      softGaps: softPrefGapsFromText("history"),
      observedListingCount: listings.length,
      observedModelCount: 8,
      emptyInventory: false,
      appliedCheckIds: ["free_gov_recalls", "compare_observed_asks"],
      listingsHaveVin: false,
      freeGovCoverage: cov,
    });
    expect(proposed.map((p) => p.id)).toContain("free_gov_safety");
    expect(proposed.map((p) => p.id)).not.toContain("free_gov_vpic");
    const loop = decideFindNextCheckLoop({
      ...loopBase,
      chosenId: "compare_observed_asks",
      remainingFreeGovCount: proposed.filter((p) => p.id.startsWith("free_gov_")).length,
    });
    expect(loop.continue).toBe(true);
    expect(loop.reason).toBe("remaining_free_checks");
  });

  it("no infinite compare retries: compare burns on apply; free remain drives one continue path", () => {
    // After compare is applied it drops from allowlist; free_gov_* stay until coverage.
    // Loop continues once for remaining free — not an unbounded compare re-pick.
    const afterCompare = proposeFindNextChecks({
      need: {
        yearMin: null,
        yearMax: null,
        milesMax: null,
        budgetKnown: false,
        budgetUsd: null,
        distanceMiles: 50,
        zip: "68114",
        conditionPriority: "inspection_first",
        mode: "personal",
        note: "suv",
        yearBandResolved: false,
        milesCapResolved: false,
      } as never,
      softGaps: softPrefGapsFromText("history"),
      observedListingCount: 24,
      observedModelCount: 5,
      emptyInventory: false,
      appliedCheckIds: ["free_gov_recalls", "compare_observed_asks"],
      listingsHaveVin: false,
      freeGovCoverage: {
        listingMmyCount: 14,
        recalls: { checked: 14, unchecked: 0, eligible: 14 },
        safety: { checked: 0, unchecked: 14, eligible: 14 },
        vpic: { checked: 0, unchecked: 0, eligible: 0 },
        fuel: { checked: 14, unchecked: 0, eligible: 14 },
        anyUnchecked: true,
        note: "recalls complete; safety open",
      },
    });
    expect(afterCompare.map((p) => p.id)).not.toContain("compare_observed_asks");
    expect(afterCompare.map((p) => p.id)).toContain("free_gov_safety");
    const freeN = afterCompare.filter((p) => p.id.startsWith("free_gov_")).length;
    const d = decideFindNextCheckLoop({
      ...loopBase,
      chosenId: "compare_observed_asks",
      remainingFreeGovCount: freeN,
      remainingActionableCount: freeN + 1,
    });
    expect(d.continue).toBe(true);
    expect(d.reason).toBe("remaining_free_checks");
    // Second compare no-op with free exhausted → terminal
    const done = decideFindNextCheckLoop({
      ...loopBase,
      chosenId: "compare_observed_asks",
      remainingFreeGovCount: 0,
      remainingActionableCount: 0,
    });
    expect(done.continue).toBe(false);
  });
});

describe("parkOutside ≠ parkIt regressions", () => {
  it("parkOutside-only facts stay distinct in receipt lines and brief coverage", () => {
    const facts = riskFactsFromPacket(
      recallPacket({
        parkIt: false,
        parkOutside: true,
        campaigns: [{ campaignNumber: "20V543000", parkIt: false, parkOutSide: true }],
        recallCount: 1,
      }),
      { make: "Hyundai", model: "Tucson", year: 2018 },
    );
    expect(facts.parkIt).toBe(false);
    expect(facts.parkOutside).toBe(true);
    const line = formatFreeGovReceiptsForUi([
      {
        toolId: "evidence.gov_recalls",
        status: "ok",
        summary: "NHTSA recalls 1 campaign(s)",
        make: "Hyundai",
        model: "Tucson",
        year: 2018,
        sourceUrl: facts.sourceUrl,
        riskFacts: {
          parkIt: false,
          parkOutside: true,
          campaignNumbers: facts.campaignNumbers,
          campaignCountReported: 1,
          complaintCount: 398,
        },
      },
    ])[0]!;
    expect(line).toMatch(/outdoor-parking \/ fire-risk guidance/i);
    expect(line).not.toMatch(/park-it campaign flag for this year\/make\/model\./i);
    expect(line).not.toMatch(/api\.nhtsa\.gov|format=json|parkIt=false|parkOutside=true/i);
    const brief = freeGovReceiptsBrief([
      receipt(2018, "Hyundai", "Tucson", { riskFacts: facts }),
    ]);
    expect(brief.allCoverage[0]!.parkOutside).toBe(true);
    expect(brief.allCoverage[0]!.parkIt).toBe(false);
  });
});
