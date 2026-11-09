/**
 * Offline Find baseline harness.
 * Zero network by default. Uses the recorded Scenario2-shaped fixture only.
 *
 * Prints pick vs baselines, per-car flags, pick changes caused by checks,
 * and decision-log length. Writes eval/results/find-baseline.md.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { selectBestDealOnEvidence } from "../src/domain/find-best-deal";
import { executeCarConsistency, trimsMatch, type VpicSpecs } from "../src/domain/find-car-consistency";
import { presentDecisionLogForBuyer, top5Ranks, type FindDecisionLogEntry } from "../src/domain/find-decision-log";
import { recallEvidenceState } from "../src/domain/find-evidence-state";
import type { FindFreeGovReceipt } from "../src/domain/find-free-gov";
import { explicitNeedFromText } from "../src/domain/need";
import { buildPurchaseReadiness } from "../src/domain/purchase-readiness";

const fetchImpl = globalThis.fetch;
globalThis.fetch = (() => {
  throw new Error("eval:find-baseline refuses network. Unset is not supported; this harness is offline.");
}) as typeof fetch;
void fetchImpl;

type FixtureCar = {
  vin: string;
  year: number;
  make: string;
  model: string;
  priceUsd: number;
  miles: number;
  trim: string | null;
  engine: string | null;
  drivetrain: string | null;
  fuel: string | null;
  accidentCount: number | null;
  ownerCount: number | null;
  usageType: string | null;
  createdAt: string | null;
  vpic: VpicSpecs;
};

type Fixture = {
  note: string;
  zip: string;
  budgetUsd: number;
  cars: FixtureCar[];
  emptyRecall: { year: number; make: string; model: string; status: string; recallsAvailable: boolean; campaignCountReported: number };
};

const fixture = JSON.parse(
  readFileSync(resolve("eval/fixtures/find-scenario2.json"), "utf8"),
) as Fixture;

const parsed = explicitNeedFromText(fixture.note, "personal");
const need = {
  ...parsed,
  budgetKnown: true,
  budgetUsd: fixture.budgetUsd,
  zip: fixture.zip,
  conditionPriority: "inspection_first" as const,
  yearMin: parsed.yearMin ?? 2012,
};

const listings = fixture.cars.map((car) => ({
  vin: car.vin,
  year: car.year,
  make: car.make,
  model: car.model,
  priceUsd: car.priceUsd,
  miles: car.miles,
  trim: car.trim,
  engine: car.engine,
  drivetrain: car.drivetrain,
  fuel: car.fuel,
  accidentCount: car.accidentCount,
  ownerCount: car.ownerCount,
  oneOwner: car.ownerCount === 1,
  usageType: car.usageType,
  createdAt: car.createdAt,
  cpo: null,
}));

const before = selectBestDealOnEvidence({ need, listings });
const vpicReceipts: FindFreeGovReceipt[] = fixture.cars.map((car) => ({
  checkId: "free_gov_vpic",
  toolId: "evidence.gov_vpic",
  status: "ok",
  summary: "recorded decode",
  scope: "fixture",
  limitsNote: "",
  vin: car.vin,
  make: car.make,
  model: car.model,
  year: car.year,
  fetchedAt: "2026-11-09T00:00:00Z",
  cached: false,
  sourceUrl: null,
  factNotes: [],
  riskFacts: null,
  fuelEvidence: null,
  honesty: "fixture",
  vpicSpecs: {
    year: car.vpic.year,
    make: car.vpic.make,
    model: car.vpic.model,
    trim: car.vpic.trim,
    drivetrain: car.vpic.drivetrain,
    engine: car.vpic.engine,
    fuel: car.vpic.fuel,
  },
}));

const emptyRecall: FindFreeGovReceipt = {
  checkId: "free_gov_recalls",
  toolId: "evidence.gov_recalls",
  status: "empty",
  summary: "empty CR-V 2015 response",
  scope: "fixture",
  limitsNote: "",
  vin: null,
  make: fixture.emptyRecall.make,
  model: fixture.emptyRecall.model,
  year: fixture.emptyRecall.year,
  fetchedAt: "2026-11-09T00:00:00Z",
  cached: false,
  sourceUrl: null,
  factNotes: [],
  riskFacts: {
    parkIt: null,
    parkOutside: null,
    campaignNumbers: [],
    campaignCountReported: fixture.emptyRecall.campaignCountReported,
    complaintCount: null,
    recallsAvailable: fixture.emptyRecall.recallsAvailable,
    complaintsAvailable: false,
    sourceUrl: null,
    toolId: "evidence.gov_recalls",
    scope: "fixture",
    vinOpenRecalls: null,
    make: fixture.emptyRecall.make,
    model: fixture.emptyRecall.model,
    year: fixture.emptyRecall.year,
    listingKey: "honda|cr-v|2015",
    cached: false,
  },
  fuelEvidence: null,
  honesty: "empty is not a clean zero",
};

const targets = before.ranked.slice(0, 3).map((row) => row.key);
const carChecks = executeCarConsistency({
  listings,
  targetKeys: targets,
  vpicReceipts,
  now: new Date("2026-11-09T12:00:00Z"),
});
const afterRecall = selectBestDealOnEvidence({
  need,
  listings,
  receipts: [emptyRecall],
});
const after = selectBestDealOnEvidence({
  need,
  listings,
  receipts: [emptyRecall],
  carChecks,
});

const names = listings.map((car) => ({
  key: car.vin,
  year: car.year,
  make: car.make,
  model: car.model,
}));
const log: FindDecisionLogEntry[] = [
  {
    hop: 1,
    decidedBy: "code",
    invokeReason: "free_gov_deterministic_drain",
    action: "free_gov_recalls",
    targetCars: [],
    evidenceAdded: [
      recallEvidenceState(emptyRecall) === "could_not_check"
        ? "Couldn't confirm recall campaigns for the 2015 Honda CR-V."
        : "Recall check recorded.",
    ],
    top5Before: top5Ranks(before.ranked),
    top5After: top5Ranks(afterRecall.ranked),
    pickBefore: before.pick?.key ?? null,
    pickAfter: afterRecall.pick?.key ?? null,
  },
  {
    hop: 2,
    decidedBy: "SERV",
    invokeReason: "shortlist_changed",
    action: "free_car_consistency",
    targetCars: targets,
    evidenceAdded: carChecks.flatMap((row) => row.fields.filter((field) => field.state === "issue_found").map((field) => field.plain)).slice(0, 4),
    top5Before: top5Ranks(afterRecall.ranked),
    top5After: top5Ranks(after.ranked),
    pickBefore: afterRecall.pick?.key ?? null,
    pickAfter: after.pick?.key ?? null,
  },
];
const plainLog = presentDecisionLogForBuyer(log, names);
const flagCount = carChecks.reduce(
  (sum, row) => sum + row.sellerQuestions.length + (row.identityMismatch ? 1 : 0),
  0,
);
const pickChanges = [before.pick?.key !== afterRecall.pick?.key, afterRecall.pick?.key !== after.pick?.key].filter(Boolean).length;
const baseline = after.baseline;
const pickLabel = baseline.pick
  ? `${baseline.pick.year} ${baseline.pick.make} ${baseline.pick.model}`
  : "no confident pick";
const cheapLabel = baseline.cheapest
  ? `${baseline.cheapest.year} ${baseline.cheapest.make} ${baseline.cheapest.model} $${baseline.cheapest.priceUsd}`
  : "none";
const milesLabel = baseline.lowestMiles
  ? `${baseline.lowestMiles.year} ${baseline.lowestMiles.make} ${baseline.lowestMiles.model} ${baseline.lowestMiles.miles} mi`
  : "none";

const readinessPool = listings.map((car) => ({
  vin: car.vin,
  year: car.year,
  make: car.make,
  model: car.model,
  trim: car.trim,
  priceUsd: car.priceUsd,
  miles: car.miles,
  createdAt: car.createdAt,
  accidentCount: car.accidentCount,
}));
const readinessNow = new Date("2026-11-09T12:00:00Z");
const readinessLines = (after.pick ? [after.pick, ...after.ranked.filter((row) => row.key !== after.pick?.key)] : after.ranked)
  .slice(0, 5)
  .flatMap((row) => {
    const source = fixture.cars.find((car) => car.vin === row.vin || car.vin === row.key);
    const title = `${row.year} ${row.make} ${row.model}`;
    const trimNote =
      source && trimsMatch(source.trim, source.vpic.trim) === false
        ? `The listing says trim ${source.trim}, but the VIN decoder says ${source.vpic.trim}. Ask the seller to confirm the trim before you rely on the equipment.`
        : null;
    const decodedMake = source?.vpic.make ?? null;
    const decodedModel = source?.vpic.model ?? null;
    const decodedYear = source?.vpic.year ?? null;
    const identityNote =
      (decodedYear != null && String(decodedYear) !== String(row.year)) ||
      (decodedMake != null && decodedMake.toLowerCase() !== row.make.toLowerCase()) ||
      (decodedModel != null && decodedModel.toLowerCase() !== row.model.toLowerCase())
        ? `${title} is listed with a VIN year, make, or model that does not match the government VIN decoder. Ask the seller to photograph the VIN plate and the title before you pay.`
        : null;
    const view = buildPurchaseReadiness({
      car: {
        vin: row.vin,
        year: row.year,
        make: row.make,
        model: row.model,
        priceUsd: row.priceUsd,
        miles: row.miles,
        createdAt: source?.createdAt ?? null,
        accidentCount: source?.accidentCount ?? null,
        trim: source?.trim ?? null,
      },
      pool: readinessPool,
      zip: fixture.zip,
      zipUsedFor: "search",
      now: readinessNow,
      trimMismatchNote: trimNote,
      identityMismatchNote: identityNote,
      recallCampaignCount: null,
    });
    const lines = [
      `### ${title}${after.pick?.key === row.key ? " (pick)" : ""}`,
      "",
      view.otd.headline,
      ...view.otd.lines,
      view.offer.openingLabel,
      view.offer.walkAwayLabel,
      view.offer.sentence,
    ];
    if (view.talkingPoints.length > 0) {
      lines.push("", "Negotiation:", ...view.talkingPoints.map((point) => `- ${point.text}`));
    }
    if (view.talkingPointsNote) lines.push(view.talkingPointsNote);
    lines.push("");
    return lines;
  });

const text = [
  "# Find baseline (offline)",
  "",
  `Fixture: eval/fixtures/find-scenario2.json (Scenario2-shaped, ZIP ${fixture.zip}, budget $${fixture.budgetUsd}).`,
  "Network: none.",
  "",
  `Pick: ${pickLabel}`,
  `Cheapest in budget: ${cheapLabel}${baseline.cheapestIsPick ? " (same as the pick)" : ""}`,
  `Lowest miles in budget: ${milesLabel}${baseline.lowestMilesIsPick ? " (same as the pick)" : ""}`,
  `Why not the cheapest: ${baseline.whyNotCheapest}`,
  "",
  `Per-car flags: ${flagCount}`,
  `Pick changes caused by checks: ${pickChanges}`,
  `Decision-log length: ${log.length}`,
  `Empty 2015 CR-V recall state: ${recallEvidenceState(emptyRecall)}`,
  "",
  "## How Lemonless decided",
  "",
  ...plainLog.lines.map((line) => `- ${line}`),
  ...(plainLog.hiddenSteps.length > 0
    ? ["", "Show all steps:", ...plainLog.hiddenSteps.map((line) => `- ${line}`)]
    : []),
  "",
  "## Purchase readiness",
  "",
  "Out-the-door uses the fixture ZIP and the checked-in state base sales-tax table. An offer needs at least 3 same-trim listings in this fixture, within 1 model year and mileage within 15 percent of that car. No network and no paid call.",
  "",
  ...readinessLines,
  "",
].join("\n");

mkdirSync(resolve("eval/results"), { recursive: true });
writeFileSync(resolve("eval/results/find-baseline.md"), text);
process.stdout.write(text);
