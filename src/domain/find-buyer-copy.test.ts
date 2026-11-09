import { describe, expect, it } from "vitest";
import {
  assertBuyerSafeText,
  findForbiddenTechArtifacts,
  formatBuyerLoopStatus,
  formatBuyerLoopStep,
  formatBuyerReceiptLine,
  machineReceiptsPayload,
} from "./find-buyer-copy";
import type { FindFreeGovReceipt } from "./find-free-gov";
import { buildFindFuelAssumptions } from "./find-fuel-match";
import { formatFreeGovReceiptsForUi } from "./find-free-gov-format";
import { buildGroundedShortlist } from "./find-path";
import { explicitNeedFromText } from "./need";

function recallReceipt(): FindFreeGovReceipt {
  return {
    checkId: "free_gov_recalls",
    toolId: "evidence.gov_recalls",
    status: "ok",
    summary: "ok",
    scope: "test",
    limitsNote: "",
    vin: "4T1B11HK8JU036347",
    make: "Toyota",
    model: "Camry",
    year: 2018,
    fetchedAt: "2026-11-09T12:00:00.000Z",
    cached: false,
    sourceUrl:
      "https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/4T1B11HK8JU036347?format=json",
    factNotes: [],
    riskFacts: {
      parkIt: false,
      parkOutside: false,
      campaignNumbers: ["18V123"],
      campaignCountReported: 1,
      complaintCount: 2,
      recallsAvailable: true,
      complaintsAvailable: true,
      sourceUrl: "https://api.nhtsa.gov/recalls/recallsByVehicle?make=Toyota&model=Camry&modelYear=2018",
      toolId: "evidence.gov_recalls",
      scope: "test",
      vinOpenRecalls: null,
      make: "Toyota",
      model: "Camry",
      year: 2018,
      listingKey: "toyota|camry|2018",
      cached: false,
    },
    fuelEvidence: null,
    honesty: "test",
  };
}

describe("buyer-safe Find copy", () => {
  it("buyer receipt lines never include raw API URLs or format=json", () => {
    const line = formatBuyerReceiptLine(recallReceipt());
    expect(assertBuyerSafeText(line).ok).toBe(true);
    expect(line).not.toMatch(/vpic\.nhtsa|format=json|api\.nhtsa\.gov/i);
    expect(line).toMatch(/NHTSA recalls \(U\.S\. government\)/);
    expect(line).toMatch(/2018 Toyota Camry/);
  });

  it("formatFreeGovReceiptsForUi is buyer-safe across mixed receipts", () => {
    const fuel: FindFreeGovReceipt = {
      ...recallReceipt(),
      checkId: "free_gov_fuel",
      toolId: "evidence.gov_fuel",
      sourceUrl: "https://www.fueleconomy.gov/ws/rest/vehicle/42015",
      riskFacts: null,
      fuelEvidence: {
        match: "exact",
        ambiguous: false,
        combMpgLow: 34,
        combMpgHigh: 34,
        cityMpgLow: 29,
        cityMpgHigh: 29,
        highwayMpgLow: 41,
        highwayMpgHigh: 41,
        annualFuelUsdLow: 1465,
        annualFuelUsdHigh: 1465,
        epaAnnualUsdLow: 1850,
        epaAnnualUsdHigh: 1850,
        fuelType: "Regular Gasoline",
        configsConsidered: 1,
        optionTexts: ["4 cyl"],
        epaVehicleIds: [42015],
        modelNamesTried: ["Camry"],
        assumptions: buildFindFuelAssumptions({
          note: "Mostly city driving",
          usdPerGallon: 4.15,
          priceSource: "fueleconomy.gov/fuelprices",
          priceKey: "regular",
        }),
        sourceUrl: "https://www.fueleconomy.gov/ws/rest/vehicle/42015",
        humanPageUrl: "https://www.fueleconomy.gov/feg/Find.do?action=sbs&id=42015",
        reason: null,
        honesty: "test",
      },
    };
    const lines = formatFreeGovReceiptsForUi([
      {
        checkId: recallReceipt().checkId,
        toolId: recallReceipt().toolId,
        status: "ok",
        summary: "ok",
        make: "Toyota",
        model: "Camry",
        year: 2018,
        vin: recallReceipt().vin,
        sourceUrl: recallReceipt().sourceUrl,
        riskFacts: recallReceipt().riskFacts,
      },
      {
        checkId: "free_gov_fuel",
        toolId: "evidence.gov_fuel",
        status: "ok",
        summary: "fuel",
        make: "Toyota",
        model: "Camry",
        year: 2018,
        sourceUrl: fuel.sourceUrl,
        fuelEvidence: fuel.fuelEvidence,
      },
    ]);
    for (const line of lines) {
      expect(findForbiddenTechArtifacts(line)).toEqual([]);
    }
  });

  it("loop steps and statuses use plain English — no reason tags or checkIds", () => {
    expect(formatBuyerLoopStep({ chosenId: "compare_observed_asks", listingCount: 24 })).toBe(
      "We compared asking prices across the 24 cars found.",
    );
    expect(
      formatBuyerLoopStep({
        chosenId: "free_gov_fuel",
        listingCount: 24,
        fuelOutcome: {
          attempted: 3,
          matched: 2,
          noMatch: 1,
          unavailable: 0,
          modelCount: 3,
          matchedModelCount: 2,
        },
      }),
    ).toMatch(/Fuel costs found|model year/i);
    expect(formatBuyerLoopStatus("unchanged_state")).toMatch(/caught up/i);
    expect(formatBuyerLoopStatus("evidence_changed_replan")).toMatch(/continuing/i);
    expect(assertBuyerSafeText(formatBuyerLoopStatus("remaining_free_checks")!).ok).toBe(true);
    expect(assertBuyerSafeText(formatBuyerLoopStep({ chosenId: "free_gov_vpic" })).ok).toBe(true);
  });

  it("machine channel retains raw source URLs for agents", () => {
    const payload = JSON.parse(machineReceiptsPayload([recallReceipt()]));
    expect(payload.channel).toBe("for-agents");
    expect(payload.receipts[0].sourceUrl).toMatch(/DecodeVinValues|format=json|api\.nhtsa/);
  });

  it("detects forbidden technical artifacts", () => {
    const dirty =
      "SERV chose compare_observed_asks — [unchanged_state] src=https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/X?format=json MMY vPIC parkIt";
    const hits = findForbiddenTechArtifacts(dirty);
    expect(hits.length).toBeGreaterThan(3);
    expect(findForbiddenTechArtifacts("capped by app validation (not a documented provider hard limit)")).toEqual(
      expect.arrayContaining([expect.stringMatching(/app validation/i), expect.stringMatching(/provider hard limit/i)]),
    );
  });

  it("grounded shortlist why/unknowns stay buyer-safe (no MMY/parkIt/vPIC)", () => {
    const need = {
      ...explicitNeedFromText("family SUV around fifteen thousand", "personal"),
      budgetKnown: true,
      budgetUsd: 15_000,
      milesMax: null,
      milesCapResolved: true,
      yearMin: 2014,
      conditionPriority: "inspection_first" as const,
    };
    const short = buildGroundedShortlist(
      need,
      [{ make: "Kia", model: "Sportage", year: 2019, priceUsd: 15_000, miles: 60_000 }],
      {},
      [
        {
          ...recallReceipt(),
          make: "Kia",
          model: "Sportage",
          year: 2019,
          riskFacts: {
            ...recallReceipt().riskFacts!,
            parkIt: false,
            parkOutside: true,
            make: "Kia",
            model: "Sportage",
            year: 2019,
            listingKey: "kia|sportage|2019",
          },
        },
      ],
    );
    expect(short.length).toBeGreaterThan(0);
    for (const row of short) {
      const rendered = `${row.make} ${row.model}: ${row.why}. Still unknown: ${row.unknowns.join("; ")}`;
      expect(findForbiddenTechArtifacts(rendered)).toEqual([]);
    }
  });
});
