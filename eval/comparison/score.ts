/**
 * Computed scoring for the comparison harness.
 * Labels are inputs to scoring only — never passed into arms.
 */
import { quotedNumbersStayIn } from "@/domain/decision-note";
import type {
  ArmOutput,
  CaseScore,
  CheckCaseFixture,
  ComparisonArmId,
  ComparisonReport,
  FindCaseFixture,
  PriceBand,
} from "./types";

const PRICE_BAND_ORDER: PriceBand[] = ["far_below", "below", "fair", "above", "far_above"];

export function bandFromAskVsFair(ask: number | null, fair: number | null): PriceBand {
  if (ask == null || fair == null || fair <= 0) return "unknown";
  const gap = (ask - fair) / fair;
  if (gap <= -0.2) return "far_below";
  if (gap <= -0.08) return "below";
  if (gap <= 0.08) return "fair";
  if (gap <= 0.2) return "above";
  return "far_above";
}

function notRunScore(
  caseId: string,
  kind: "find" | "check",
  synthetic: boolean,
  arm: ComparisonArmId,
): CaseScore {
  return {
    caseId,
    kind,
    synthetic,
    arm,
    status: "not_run",
    pickedSold: null,
    pickedAvoid: null,
    priceErrorUsd: null,
    priceBandMatch: null,
    redFlagsCaught: null,
    redFlagsExpected: null,
    inventedNumber: null,
    statedUnknowns: null,
    latencyMs: null,
    costUsd: null,
  };
}

export function scoreArmOnFind(input: {
  fixture: FindCaseFixture;
  output: ArmOutput;
}): CaseScore {
  if (input.output.status !== "ran") {
    return notRunScore(input.fixture.id, "find", input.fixture.synthetic, input.output.arm);
  }
  const pick = input.output.pickVin;
  const sold = Boolean(pick && input.fixture.labels.soldVins.includes(pick));
  const avoid = Boolean(pick && input.fixture.labels.expectedAvoidVins.includes(pick));
  const fair = pick ? input.fixture.labels.fairValueByVin[pick] : undefined;
  const priceErrorUsd =
    fair != null && input.output.fairValueUsd != null
      ? Math.abs(input.output.fairValueUsd - fair)
      : null;
  const expectedBand =
    pick && fair != null
      ? bandFromAskVsFair(
          input.fixture.listings.find((row) => row.vin === pick)?.priceUsd ?? null,
          fair,
        )
      : null;
  const priceBandMatch =
    expectedBand == null || expectedBand === "unknown" || input.output.priceVerdict === "unknown"
      ? null
      : input.output.priceVerdict === expectedBand ||
        Math.abs(PRICE_BAND_ORDER.indexOf(input.output.priceVerdict) - PRICE_BAND_ORDER.indexOf(expectedBand)) <= 1;

  const expectedFlags = pick
    ? input.fixture.labels.expectedRedFlagIdsByVin[pick] ?? []
    : Object.values(input.fixture.labels.expectedRedFlagIdsByVin).flat();
  const caught = expectedFlags.filter((id) =>
    input.output.redFlags.some(
      (flag) => flag.toLowerCase().includes(id.toLowerCase()) || id.toLowerCase().includes(flag.toLowerCase()),
    ),
  ).length;

  const allowed = JSON.stringify({
    query: input.fixture.query,
    budgetUsd: input.fixture.budgetUsd,
    zip: input.fixture.zip,
    listings: input.fixture.listings,
    comps: input.fixture.comps,
  });

  return {
    caseId: input.fixture.id,
    kind: "find",
    synthetic: input.fixture.synthetic,
    arm: input.output.arm,
    status: "ran",
    pickedSold: sold,
    pickedAvoid: avoid,
    priceErrorUsd,
    priceBandMatch,
    redFlagsCaught: caught,
    redFlagsExpected: expectedFlags.length,
    inventedNumber: !quotedNumbersStayIn(input.output.textForNumbers, allowed),
    statedUnknowns: input.output.unknowns.length,
    latencyMs: input.output.latencyMs,
    costUsd: input.output.costUsd,
  };
}

export function scoreArmOnCheck(input: {
  fixture: CheckCaseFixture;
  output: ArmOutput;
}): CaseScore {
  if (input.output.status !== "ran") {
    return notRunScore(input.fixture.id, "check", input.fixture.synthetic, input.output.arm);
  }
  const treatedAsBuyable =
    input.fixture.labels.isSold &&
    !input.output.redFlags.some((f) => /sold|unavailable/i.test(f)) &&
    !/sold|unavailable|do not buy|walk away|\bpass\b/i.test(input.output.summary);

  const fair = input.fixture.labels.fairValueUsd;
  const priceErrorUsd =
    fair != null && input.output.fairValueUsd != null ? Math.abs(input.output.fairValueUsd - fair) : null;
  const priceBandMatch =
    input.fixture.labels.expectedPriceBand === "unknown" || input.output.priceVerdict === "unknown"
      ? null
      : input.output.priceVerdict === input.fixture.labels.expectedPriceBand ||
        Math.abs(
          PRICE_BAND_ORDER.indexOf(input.output.priceVerdict) -
            PRICE_BAND_ORDER.indexOf(input.fixture.labels.expectedPriceBand),
        ) <= 1;

  const expected = input.fixture.labels.expectedRedFlagIds;
  const caught = expected.filter(
    (id) =>
      input.output.redFlags.some(
        (flag) => flag.toLowerCase().includes(id.toLowerCase()) || id.toLowerCase().includes(flag.toLowerCase()),
      ) || new RegExp(id.replace(/_/g, "[ _-]"), "i").test(input.output.summary),
  ).length;

  const allowed = JSON.stringify({
    rawText: input.fixture.rawText,
    subject: input.fixture.subject,
    comps: input.fixture.comps,
  });

  return {
    caseId: input.fixture.id,
    kind: "check",
    synthetic: input.fixture.synthetic,
    arm: input.output.arm,
    status: "ran",
    pickedSold: treatedAsBuyable,
    pickedAvoid: false,
    priceErrorUsd,
    priceBandMatch,
    redFlagsCaught: caught,
    redFlagsExpected: expected.length,
    inventedNumber: !quotedNumbersStayIn(input.output.textForNumbers, allowed),
    statedUnknowns: input.output.unknowns.length,
    latencyMs: input.output.latencyMs,
    costUsd: input.output.costUsd,
  };
}

export function summarizeTotals(
  scores: CaseScore[],
  opts: { includeScores: boolean },
): ComparisonReport["totals"] {
  if (!opts.includeScores) return null;
  const arms: ComparisonArmId[] = ["lemonless", "plain_llm", "cheapest"];
  const out = {} as NonNullable<ComparisonReport["totals"]>;
  for (const arm of arms) {
    const rows = scores.filter((row) => row.arm === arm);
    const ran = rows.filter((row) => row.status === "ran");
    const priceErrors = ran.map((row) => row.priceErrorUsd).filter((n): n is number => n != null);
    const flagExpected = ran.reduce((sum, row) => sum + (row.redFlagsExpected ?? 0), 0);
    const flagCaught = ran.reduce((sum, row) => sum + (row.redFlagsCaught ?? 0), 0);
    const costs = ran.map((row) => row.costUsd).filter((n): n is number => n != null);
    const lat = ran.map((row) => row.latencyMs).filter((n): n is number => n != null);
    out[arm] = {
      cases: rows.length,
      realCases: rows.filter((row) => !row.synthetic).length,
      syntheticCases: rows.filter((row) => row.synthetic).length,
      pickedSold: ran.filter((row) => row.pickedSold).length,
      pickedAvoid: ran.filter((row) => row.pickedAvoid).length,
      inventedNumber: ran.filter((row) => row.inventedNumber).length,
      avgPriceErrorUsd: priceErrors.length
        ? Math.round(priceErrors.reduce((a, b) => a + b, 0) / priceErrors.length)
        : null,
      redFlagRecall: flagExpected > 0 ? Number((flagCaught / flagExpected).toFixed(3)) : null,
      avgLatencyMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : 0,
      totalCostUsd: costs.length ? Number(costs.reduce((a, b) => a + b, 0).toFixed(4)) : null,
      notRun: rows.filter((row) => row.status === "not_run").length,
    };
  }
  return out;
}
