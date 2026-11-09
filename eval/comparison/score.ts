/**
 * Computed (not opinion) scoring for the comparison harness.
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

export function scoreArmOnFind(input: {
  fixture: FindCaseFixture;
  output: ArmOutput;
}): CaseScore {
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
    input.output.redFlags.some((flag) => flag.toLowerCase().includes(id.toLowerCase()) || id.toLowerCase().includes(flag.toLowerCase())),
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
    arm: input.output.arm,
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
  // For check, "picked sold" means treating a SOLD listing as a still-buyable car.
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
  const caught = expected.filter((id) =>
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
    arm: input.output.arm,
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

export function summarizeTotals(scores: CaseScore[]): ComparisonReport["totals"] {
  const arms: ComparisonArmId[] = ["lemonless", "plain_llm", "cheapest"];
  const out = {} as ComparisonReport["totals"];
  for (const arm of arms) {
    const rows = scores.filter((row) => row.arm === arm);
    const priceErrors = rows.map((row) => row.priceErrorUsd).filter((n): n is number => n != null);
    const flagExpected = rows.reduce((sum, row) => sum + row.redFlagsExpected, 0);
    const flagCaught = rows.reduce((sum, row) => sum + row.redFlagsCaught, 0);
    const costs = rows.map((row) => row.costUsd).filter((n): n is number => n != null);
    out[arm] = {
      cases: rows.length,
      pickedSold: rows.filter((row) => row.pickedSold).length,
      pickedAvoid: rows.filter((row) => row.pickedAvoid).length,
      inventedNumber: rows.filter((row) => row.inventedNumber).length,
      avgPriceErrorUsd: priceErrors.length
        ? Math.round(priceErrors.reduce((a, b) => a + b, 0) / priceErrors.length)
        : null,
      redFlagRecall: flagExpected > 0 ? Number((flagCaught / flagExpected).toFixed(3)) : null,
      avgLatencyMs: rows.length
        ? Math.round(rows.reduce((sum, row) => sum + row.latencyMs, 0) / rows.length)
        : 0,
      totalCostUsd: costs.length ? Number(costs.reduce((a, b) => a + b, 0).toFixed(4)) : null,
    };
  }
  return out;
}
