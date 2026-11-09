import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateListingPrice } from "./price-evaluation";
import {
  assertBuyerSafeText,
  creditsNeedNotice,
  findForbiddenTechArtifacts,
  buyerCheckActivityLine,
  publicCheckStatusLine,
  formatBuyerLoopStatus,
  formatBuyerLoopStep,
  formatBuyerNextCheckWhy,
  formatBuyerProofLine,
  formatBuyerReceiptLine,
  formatGroundedShortlistLine,
  sellerQuestionsForBuyer,
  formatBuyerServCheckSummary,
  formatOfficialRecallNumber,
  machineReceiptsPayload,
  plainBuyerPhrase,
  plainCompScope,
  plainDecisionAction,
  plainDecisionSource,
  plainFlagSource,
} from "./find-buyer-copy";
import type { Listing } from "./types";
import { freeGovToolCoverage, plainPublicCheckProgress, type FindFreeGovReceipt } from "./find-free-gov";
import { buildFindFuelAssumptions } from "./find-fuel-match";
import { formatFreeGovReceiptsForUi } from "./find-free-gov-format";
import { buildGroundedShortlist } from "./find-path";
import { explicitNeedFromText, softPrefGapsFromText } from "./need";
import { whyWeDecided } from "./decision-note";
import { observedModelSnapshots } from "./find-model-observe";
import { priceBadge } from "./price-badge";
import { buildComputedReport } from "./report";
import { summaryLine } from "./summary-line";
import { fitHeadline } from "./fit";
import { templateExplanation } from "./template";
import { runOrderedGates } from "./verdict-gates";
import { clampDecision, constraintsFromGates } from "./verdict-guardrails";
import { flipAlertWhy, topFlipCandidates } from "./flip-rank";
import { prefilterListing } from "./radar-watch";
import type { RecallRecord } from "./types";

function noteCar(vin: string, year: number, priceUsd: number, trim: string): Listing {
  return {
    vin,
    year,
    make: "Kia",
    model: "Sportage",
    trim,
    miles: 60_000,
    priceUsd,
    city: null,
    state: null,
    zip: null,
    dealer: null,
    vdp: null,
    primaryImage: null,
    carfaxUrl: null,
    used: true,
    cpo: false,
    accidentCount: null,
    oneOwner: null,
    ownerCount: null,
    usageType: null,
    fuel: null,
    engine: null,
    drivetrain: null,
    bodyStyle: null,
    latitude: null,
    longitude: null,
    removedAt: null,
    source: "sample",
  };
}

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

  it("keeps the landing explainer free of listing jargon", () => {
    const layout = readFileSync(path.join(process.cwd(), "src/app/layout.tsx"), "utf8");
    const match = layout.match(/Lemonless prepares a price verdict[\s\S]*?before you pay\./);
    expect(match).toBeTruthy();
    const line = match![0].replace(/\s+/g, " ");
    expect(findForbiddenTechArtifacts(line)).toEqual([]);
    expect(line).toMatch(/similar listings of the same model and public government data/);
    expect(line).not.toMatch(/listings nearby/i);
    expect(
      findForbiddenTechArtifacts(
        "Lemonless prepares a price verdict from listing comps and public government data.",
      ),
    ).toEqual(expect.arrayContaining([expect.stringMatching(/comps/i)]));
    expect(findForbiddenTechArtifacts("25th percentile")).toEqual(
      expect.arrayContaining([expect.stringMatching(/percentile/i)]),
    );
    expect(findForbiddenTechArtifacts("fitted price")).toEqual(
      expect.arrayContaining([expect.stringMatching(/fitted/i)]),
    );
    expect(findForbiddenTechArtifacts("price≈year")).toEqual(expect.arrayContaining([expect.stringMatching(/≈/)]));
    expect(findForbiddenTechArtifacts("one comp left")).toEqual(
      expect.arrayContaining([expect.stringMatching(/comp\s/i)]),
    );

    const terms = readFileSync(path.join(process.cwd(), "src/app/terms/page.tsx"), "utf8");
    const termsLine = terms.match(/Similar listings of the\s+same model[\s\S]*?Auto\.dev\./)?.[0]?.replace(/\s+/g, " ");
    expect(termsLine).toBeTruthy();
    expect(findForbiddenTechArtifacts(termsLine!)).toEqual([]);
    expect(terms).not.toMatch(/\bcomps\b/);
    expect(terms).not.toMatch(/listings nearby/i);

    const home = readFileSync(path.join(process.cwd(), "src/components/HomeStage.tsx"), "utf8");
    expect(home).not.toMatch(/free Good, Fair, or High/i);
    expect(home).toMatch(/credit-priced search when billing is enabled/i);
    expect(home).not.toMatch(/Title, recalls and odometer checks/i);
    const homeText = [...home.matchAll(/>([^<{]+)</g)].map((match) => match[1]!.replace(/\s+/g, " ").trim()).filter(Boolean);
    expect(homeText.length).toBeGreaterThan(3);
    for (const line of homeText) expect(findForbiddenTechArtifacts(line), line).toEqual([]);

    const reportView = readFileSync(path.join(process.cwd(), "src/components/ReportView.tsx"), "utf8");
    expect(reportView).toMatch(/formatBuyerProofLine/);
    expect(reportView).toMatch(/formatBuyerServCheckSummary/);
    expect(reportView).toMatch(/plainCompScope/);
    expect(reportView).not.toMatch(/>\s*Comparables\s*</);

    expect(findForbiddenTechArtifacts(plainBuyerPhrase("price_vs_comps (pass)"))).toEqual([]);
    expect(plainBuyerPhrase("insufficient_comps: buy forbidden")).toMatch(/not enough similar listings/);
    expect(formatOfficialRecallNumber("12V501000")).toBe(
      "Official recall number 12V501000 — look this up on NHTSA",
    );
    const labeled = formatOfficialRecallNumber("12V501000");
    expect(formatOfficialRecallNumber(labeled)).toBe(labeled);
    expect(findForbiddenTechArtifacts(labeled)).toEqual([]);

    const subject = noteCar("SUBJ0000000000001", 2016, 14000, "EX");
    const peers = [12000, 13000, 15000, 16000].map((price, index) =>
      noteCar(`PEER000000000000${index}`, 2016, price, "LX"),
    );
    const priced = evaluateListingPrice(subject, [subject, ...peers]);
    for (const note of [priced.methodNote, priced.label]) {
      expect(findForbiddenTechArtifacts(note)).toEqual([]);
    }
  });

  it("detects forbidden technical artifacts", () => {
    const dirty =
      "SERV chose compare_observed_asks — [unchanged_state] src=https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/X?format=json MMY vPIC parkIt";
    const hits = findForbiddenTechArtifacts(dirty);
    expect(hits.length).toBeGreaterThan(3);
    expect(findForbiddenTechArtifacts("capped by app validation (not a documented provider hard limit)")).toEqual(
      expect.arrayContaining([expect.stringMatching(/app validation/i), expect.stringMatching(/provider hard limit/i)]),
    );
    expect(findForbiddenTechArtifacts("n=3 similar CR-V LX listings")).toEqual(
      expect.arrayContaining([expect.stringMatching(/n=3/)]),
    );
    expect(findForbiddenTechArtifacts("(n=3)")).not.toEqual([]);
    expect(findForbiddenTechArtifacts("Observed from this search only")).not.toEqual([]);
    expect(findForbiddenTechArtifacts("not a full TCO")).not.toEqual([]);
    expect(findForbiddenTechArtifacts("(+ explicit $/gal assumptions if only MPG)")).not.toEqual([]);
    expect(findForbiddenTechArtifacts("A blank budget stays blank")).not.toEqual([]);
  });

  it("plain Find copy names the sample without n=, TCO, or a blank-budget claim", () => {
    const subject = noteCar("CRV00000000000001", 2016, 15000, "LX");
    subject.make = "Honda";
    subject.model = "CR-V";
    const peers = [14000, 15500, 16000].map((price, index) => {
      const car = noteCar(`CRVP00000000000${index}`, 2016, price, "LX");
      car.make = "Honda";
      car.model = "CR-V";
      return car;
    });
    const badge = priceBadge(subject, [subject, ...peers]);
    expect(badge.deltaLabel).toMatch(/based on \d+ similar CR-V listings/);
    expect(assertBuyerSafeText(badge.deltaLabel ?? "").ok).toBe(true);

    const decided = whyWeDecided("find", [
      {
        purpose: "find_guard",
        tools: ["serv_prompt_guard"],
        features: [],
        promptGuard: "allow",
        shadowOutcome: "not_used",
        shadowMaxIterations: null,
        latencyMs: 1,
      },
    ]).join(" ");
    expect(assertBuyerSafeText(decided).ok).toBe(true);
    expect(decided).toMatch(/price in your note is the budget/);

    const snap = observedModelSnapshots([
      { make: "Honda", model: "CR-V", year: 2016, priceUsd: 15000, miles: 80000 },
    ])[0]!;
    expect(assertBuyerSafeText(snap.honesty).ok).toBe(true);
    expect(snap.honesty).toMatch(/these cards only/);

    const fuelGap = softPrefGapsFromText("reasonably cheap to run").find((gap) => gap.id === "fuel_or_running_cost");
    expect(fuelGap).toBeTruthy();
    expect(assertBuyerSafeText(fuelGap!.honesty).ok).toBe(true);

    const short = buildGroundedShortlist(
      {
        ...explicitNeedFromText("family car around $15,000", "personal"),
        budgetKnown: true,
        budgetUsd: 15_000,
      },
      [{ make: "Honda", model: "CR-V", year: 2016, priceUsd: 15000, miles: 80000 }],
    );
    for (const row of short) {
      expect(assertBuyerSafeText(row.unknowns.join(" ")).ok).toBe(true);
      expect(row.unknowns.join(" ")).not.toMatch(/\$\/gal|TCO/);
    }

    expect(
      publicCheckStatusLine({ servEnabled: true, anyUnchecked: false, checksHaveRun: false }),
    ).toMatch(/have not finished/);
    expect(
      publicCheckStatusLine({ servEnabled: true, anyUnchecked: false, checksHaveRun: true }),
    ).toMatch(/caught up/);
    expect(assertBuyerSafeText(publicCheckStatusLine({ servEnabled: true, anyUnchecked: true, checksHaveRun: false })).ok).toBe(
      true,
    );

    const findNotice = creditsNeedNotice("/find");
    expect(findNotice).toMatch(/1 report credit/);
    expect(findNotice).toMatch(/do not pay for Find/);
    expect(findNotice).toMatch(/3 free checks/);
    expect(assertBuyerSafeText(findNotice).ok).toBe(true);
    expect(assertBuyerSafeText(creditsNeedNotice("/check")).ok).toBe(true);

    for (const file of [
      "src/components/PriceBadge.tsx",
      "src/components/DecisionNote.tsx",
      "src/app/credits/page.tsx",
    ]) {
      const text = readFileSync(path.join(process.cwd(), file), "utf8");
      expect(findForbiddenTechArtifacts(text), file).toEqual([]);
    }
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
      const rendered = `${row.make} ${row.model}: ${row.why}. Still unknown: ${row.unknowns.join("; ")}${
        row.campaignRefs.length > 0
          ? `. ${row.campaignRefs.map((id) => formatOfficialRecallNumber(id)).join("; ")}`
          : ""
      }.`;
      expect(findForbiddenTechArtifacts(rendered)).toEqual([]);
      if (row.campaignRefs.length > 0) {
        expect(rendered).toMatch(/Official recall number \S+ — look this up on NHTSA/);
      }
    }
  });

  it("rendered report, check, and radar lines stay plain", () => {
    const subject = noteCar("SUBJ0000000000001", 2018, 14000, "LE");
    const peers = [12000, 13000, 15000, 16000].map((price, index) =>
      noteCar(`PEER000000000000${index}`, 2018, price, "LE"),
    );
    const recall = (campaignNumber: string, parkIt: boolean, parkOutSide: boolean): RecallRecord => ({
      campaignNumber,
      component: "Airbags",
      summary: "May deploy.",
      consequence: "Injury.",
      remedy: "Replace.",
      parkIt,
      parkOutSide,
    });
    const cases = [
      [recall("12V501000", true, false)],
      [recall("24V111", false, true)],
      [recall("24V010", false, false)],
    ];
    for (const recalls of cases) {
      for (const mode of ["personal", "flip"] as const) {
        const computed = buildComputedReport({
          mode,
          subject,
          candidates: [subject, ...peers],
          recalls,
          recallsAvailable: true,
          complaintCount: 2,
          fuel: null,
          vinDecode: null,
          distanceToSearchZipMiles: null,
          asOfYear: 2026,
        });
        const decision = summaryLine({
          mode: computed.mode,
          verdict: computed.verdict,
          fairValueUsd: computed.fairValueUsd,
          flip: computed.flip,
          openParkIt: computed.openParkIt,
          withholdReason: null,
        });
        const gates = runOrderedGates(computed);
        const clamped = clampDecision("buy", constraintsFromGates(gates, computed));
        const lines = [
          decision.line,
          decision.detail,
          fitHeadline(computed),
          templateExplanation(computed),
          plainCompScope(computed.compScope),
          `${computed.comps.length} similar listings`,
          "Similar listings",
          "Official recall number",
          "The numbers below are official recall numbers you can look up on NHTSA.",
          ...computed.reasons,
          ...computed.dataNotes,
          ...computed.questions,
          ...computed.flags.map((flag) => `${flag.text} Source: ${plainFlagSource(flag.source)}`),
          ...computed.recalls.map((item) => item.campaignNumber),
          ...gates.gates.map((gate) => `${plainBuyerPhrase(gate.id)} (${gate.status}) ${plainBuyerPhrase(gate.reason)}`),
          ...clamped.overrideReasons.map((reason) => plainBuyerPhrase(reason)),
          plainDecisionAction("needs_inspection"),
          plainDecisionSource("guardrail_clamp"),
          plainDecisionSource("no_serv_key"),
        ];
        for (const line of lines) {
          expect(findForbiddenTechArtifacts(line), line).toEqual([]);
        }
        if (computed.recalls.length > 0) {
          expect(lines.join(" ")).toMatch(/12V501000|24V111|24V010/);
        }
      }
    }

    const proofLines = [
      formatBuyerProofLine({
        id: "serv_prompt_guard",
        status: "skipped",
        detail: "SERV_API_KEY is not set. The local screen still ran. The written summary is the template.",
      }),
      formatBuyerProofLine({
        id: "government_data",
        status: "ran",
        detail: "NHTSA vPIC, NHTSA recalls, NHTSA complaints, fueleconomy.gov, US Census geocoder",
      }),
      formatBuyerProofLine({
        id: "deterministic_tools",
        status: "ran",
        detail: "evaluateListingPrice, adjustComparableSet, historyAdjustment, verdictFromPriceGap, flipMath, scoreFromGap, dealerQuestions",
      }),
      formatBuyerProofLine({
        id: "ordered_gates",
        status: "passed",
        detail: "price_vs_comps:pass, data_sufficiency:withhold, safety_red_flags:forbid",
      }),
      formatBuyerProofLine({
        id: "verdict_guardrails",
        status: "passed",
        detail: "final=needs_inspection; source=no_serv_key",
      }),
      formatBuyerProofLine({
        id: "serv_shadow_agent",
        status: "skipped",
        detail: "autoflip.explain.v1",
      }),
      formatBuyerServCheckSummary({
        purpose: "report_guard",
        promptGuard: "allow",
        shadowOutcome: "not_exposed",
      }),
      formatBuyerNextCheckWhy(
        "run_full_analysis",
        "Full analysis is per-VIN (1 credit) — pulls EPA fuel when matched. Not a free Find-card invent.",
      ),
    ];
    for (const line of proofLines) {
      expect(findForbiddenTechArtifacts(line), line).toEqual([]);
    }
    expect(proofLines.join(" ")).not.toMatch(/SERV_API_KEY|vPIC|selectComparables|evaluateListingPrice|price_vs_comps|no_serv_key|Find-card invent/i);
    expect(proofLines.join(" ")).toMatch(/Official|automatic review is not configured|NHTSA VIN decoder|1 report credit/i);

    const ranked = topFlipCandidates(
      [12000, 13000, 15000, 16000].map((price, index) => noteCar(`FLIP000000000000${index}`, 2018, price, "LE")),
      new Date("2026-11-09T00:00:00Z"),
      4,
    );
    expect(ranked.length).toBeGreaterThan(0);
    expect(findForbiddenTechArtifacts(flipAlertWhy(ranked[0]!))).toEqual([]);

    const pool = [12000, 13000, 15000, 16000].map((price, index) =>
      noteCar(`RADAR00000000000${index}`, 2018, price, "LE"),
    );
    const radar = prefilterListing(
      { ...pool[0]!, priceUsd: 9000 },
      { priceMax: 20000, zip: "68114", radiusMiles: 50, make: "Kia", model: "Sportage" },
      pool,
      "flip",
      2026,
    );
    if (radar.pass && radar.why) expect(findForbiddenTechArtifacts(radar.why)).toEqual([]);
  });
});

describe("public-check copy stays plain and honest", () => {
  it("does not claim checks are still running when nothing is in flight", () => {
    const idle = publicCheckStatusLine({
      servEnabled: true,
      anyUnchecked: true,
      checksHaveRun: true,
      running: false,
      modelCount: 17,
    });
    expect(idle).toMatch(/not running/i);
    expect(idle).not.toMatch(/keep checking|still finishing|year\/make\/model/i);
    expect(assertBuyerSafeText(idle).ok).toBe(true);

    const running = publicCheckStatusLine({
      servEnabled: true,
      anyUnchecked: true,
      checksHaveRun: false,
      running: true,
      modelCount: 17,
    });
    expect(running).toMatch(/Public safety records: checking 17 models/);
    expect(running).toMatch(/best choice may change/i);
    expect(running).not.toMatch(/\d+\/\d+|VIN decode/);

    const stillGoing = publicCheckStatusLine({
      servEnabled: true,
      anyUnchecked: false,
      checksHaveRun: true,
      running: false,
      loopOpen: true,
    });
    expect(stillGoing).toMatch(/still going to run/i);
    expect(stillGoing).not.toMatch(/caught up/i);
  });

  it("coverage progress does not say checks are running when it only describes what is left", () => {
    const listings = Array.from({ length: 17 }, (_, index) => ({
      make: "Honda",
      model: `Model${index}`,
      year: 2015 + (index % 5),
      priceUsd: 12000,
      miles: 80000,
      vin: null,
    }));
    const coverage = freeGovToolCoverage(listings, []);
    const note = plainPublicCheckProgress(coverage);
    expect(note).not.toMatch(/checking|still being checked/i);
    expect(note).toMatch(/not checked yet|not finished/i);
    expect(note).not.toMatch(/\d+\/\d+|VIN decode|year\/make\/model/i);
    expect(assertBuyerSafeText(note).ok).toBe(true);

    const running = buyerCheckActivityLine({ anyUnchecked: true, continuing: true });
    const idle = buyerCheckActivityLine({ anyUnchecked: true, continuing: false });
    expect(running).toMatch(/still being checked/i);
    expect(idle).toMatch(/not running/i);
    expect(idle).not.toMatch(/still being checked/i);
  });

  it("does not double the period after a fuel estimate", () => {
    const line = formatBuyerReceiptLine({
      ...recallReceipt(),
      checkId: "free_gov_fuel",
      toolId: "evidence.gov_fuel",
      fuelEvidence: {
        match: "exact",
        ambiguous: false,
        combMpgLow: 28,
        combMpgHigh: 28,
        cityMpgLow: 24,
        cityMpgHigh: 24,
        highwayMpgLow: 32,
        highwayMpgHigh: 32,
        annualFuelUsdLow: 1500,
        annualFuelUsdHigh: 1500,
        epaAnnualUsdLow: null,
        epaAnnualUsdHigh: null,
        fuelType: "Regular Gasoline",
        configsConsidered: 1,
        optionTexts: [],
        epaVehicleIds: [],
        modelNamesTried: [],
        assumptions: buildFindFuelAssumptions({ note: "city driving" }),
        sourceUrl: null,
        humanPageUrl: null,
        reason: null,
        honesty: "labeled estimate.",
      },
    });
    expect(line).not.toMatch(/\.\./);
    expect(line).toMatch(/Est\. fuel/);

    const short = formatGroundedShortlistLine({
      make: "Honda",
      model: "CR-V",
      why: "3 observed cards",
      unknowns: ["miles-per-gallon alone is not turned into a dollar estimate."],
    });
    expect(short).not.toMatch(/\.\./);
    expect(short).toMatch(/estimate\.$/);
  });

  it("shows a seller question when the card already says the listing reports an accident", () => {
    const car = {
          key: "CRV",
          make: "Honda",
          model: "CR-V",
          year: 2017,
          priceUsd: 14950,
          miles: 78000,
          vin: "CRV",
          score: 30,
          factors: [
            {
              id: "listing_feed_flags" as const,
              label: "Listing history flags",
              points: 0,
              detail: "Listing reports 1 accident — not reflected in this Find market figure",
              source: "Listing feed flags on this card",
            },
          ],
          unknowns: [],
          fuelSummary: null,
          excludedFromPick: false,
          excludedReason: null,
          sellerQuestions: [],
    };
    const lines = sellerQuestionsForBuyer({ ranked: [car], pick: car });
    expect(lines.join(" ")).toMatch(/Ask the seller for accident records/i);
    expect(lines.join(" ")).toMatch(/2017 Honda CR-V/);
  });

  it("does not double-append (listing n) and only names shown top picks", () => {
    const pick = {
      key: "t1",
      year: 2017,
      make: "Hyundai",
      model: "Tucson",
      priceUsd: 14_800,
      miles: 80_000,
      vin: null,
      score: 10,
      factors: [],
      unknowns: [],
      fuelSummary: null,
      excludedFromPick: false,
      excludedReason: null,
      sellerQuestions: ["Ask about service records on the 2017 Hyundai Tucson."],
      city: "Omaha",
      dealer: "A Dealer",
    };
    const other = {
      ...pick,
      key: "camry",
      make: "Toyota",
      model: "Camry",
      priceUsd: 14_800,
      sellerQuestions: ["Ask about the 2017 Toyota Camry ($14,800)."],
    };
    const twin = {
      ...pick,
      key: "t2",
      miles: 95_000,
      priceUsd: 13_900,
      sellerQuestions: ["Ask about accidents on the 2017 Hyundai Tucson."],
    };
    const lines = sellerQuestionsForBuyer({
      ranked: [pick, twin, other],
      pick,
      shownKeys: [pick.key, twin.key],
    });
    const joined = lines.join(" | ");
    expect(joined).not.toMatch(/\(listing 1\) \(listing 1\)/);
    expect(joined).not.toMatch(/Toyota Camry/);
    expect(joined).toMatch(/Tucson/);
  });
});
