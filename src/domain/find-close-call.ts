/**
 * Close-call policy for Find.
 * Scores within the best-deal margin are not a confident pick.
 * Spend remaining free per-car checks on the tied cars first, then at most
 * one paid tie-break under the existing SERV cap, then say what is leaning
 * and what would decide it.
 */

import type { BestDealCandidate, BestDealFactorId } from "./find-best-deal";

/**
 * Must stay equal to BEST_DEAL_TIE_EPSILON. Passed explicitly by callers that
 * already import the scoring constant, so this module does not import it.
 */
export const CLOSE_CALL_MARGIN = 2.5;

export function closeCallCars<T extends { score: number; excludedFromPick?: boolean }>(
  ranked: readonly T[],
  epsilon = CLOSE_CALL_MARGIN,
): T[] {
  const eligible = ranked.filter((car) => !car.excludedFromPick);
  const first = eligible[0];
  if (!first) return [];
  const tied: T[] = [first];
  for (const car of eligible.slice(1)) {
    if (Math.abs(first.score - car.score) <= epsilon) tied.push(car);
    else break;
  }
  return tied.length >= 2 ? tied : [];
}

const LEAD: Record<BestDealFactorId, (lead: string, other: string) => string> = {
  price_vs_model_asks: (lead, other) =>
    `${lead} is priced better against similar listings than the ${other}.`,
  miles_per_year_vs_peers: (lead, other) =>
    `${lead} has lower miles for its age than the ${other}.`,
  age: (lead, other) => `${lead} is newer or less worn than the ${other}.`,
  estimated_fuel_cost: (lead, other) => `${lead} should cost less to fuel than the ${other}.`,
  mmy_recall_campaigns: (lead, other) =>
    `${lead} has a cleaner recall record on the checks we ran than the ${other}.`,
  mmy_ncap_rating: (lead, other) => `${lead} has a stronger crash-test rating than the ${other}.`,
  named_model_preference: (lead, other) =>
    `${lead} matches what you named more closely than the ${other}.`,
  budget_fit: (lead, other) => `${lead} fits the budget better than the ${other}.`,
  condition_priority: (lead, other) =>
    `${lead} looks better on the condition checks we have than the ${other}.`,
  listing_feed_flags: (lead, other) => `${lead} has fewer listing warnings than the ${other}.`,
  days_listed: (lead, other) => `${lead} has been on the market a different length of time than the ${other}.`,
};

/** One plain reason the first car leads. No internal scores. */
export function closeCallLeadReason(
  first: BestDealCandidate,
  second: BestDealCandidate,
  labelOf: (car: BestDealCandidate) => string,
): string {
  const lead = labelOf(first);
  const other = labelOf(second);
  let best: { id: BestDealFactorId; delta: number } | null = null;
  for (const factor of first.factors) {
    const otherPoints = second.factors.find((row) => row.id === factor.id)?.points ?? 0;
    const delta = factor.points - otherPoints;
    if (!best || delta > best.delta) best = { id: factor.id, delta };
  }
  if (best && best.delta > 0) return LEAD[best.id](lead, other);
  if (first.priceUsd != null && second.priceUsd != null && first.priceUsd < second.priceUsd) {
    return `${lead} asks less than the ${other}.`;
  }
  if (first.miles != null && second.miles != null && first.miles < second.miles) {
    return `${lead} has fewer miles than the ${other}.`;
  }
  return `${lead} is listed first, and the two cars are very close.`;
}

/** One to three specific actions. Names the cars. No internal scores. */
export function whatWouldDecideCloseCall(
  cars: readonly BestDealCandidate[],
  labelOf: (car: BestDealCandidate) => string,
): string[] {
  const actions: string[] = [];
  const push = (line: string) => {
    if (actions.length >= 3) return;
    if (!actions.includes(line)) actions.push(line);
  };
  for (const car of cars.slice(0, 3)) {
    const name = labelOf(car);
    if (car.sellerQuestions.some((question) => /trim/i.test(question))) {
      push(`Seller confirms the trim on the ${name}.`);
    }
  }
  for (const car of cars.slice(0, 3)) {
    const name = labelOf(car);
    if (car.sellerQuestions.some((question) => /odometer/i.test(question))) {
      push(`Seller confirms the odometer reading and service records on the ${name}.`);
    }
  }
  for (const car of cars.slice(0, 2)) {
    const name = labelOf(car);
    if (car.sellerQuestions.some((question) => /accident/i.test(question))) {
      push(`Seller explains the accident record on the ${name}.`);
    }
  }
  const names = cars.slice(0, 2).map((car) => labelOf(car));
  if (names.length >= 2) push(`A history report on the ${names[0]} and the ${names[1]}.`);
  else if (names[0]) push(`A history report on the ${names[0]}.`);
  if (names[0]) push(`A pre-purchase inspection of the ${names[0]}.`);
  return actions.slice(0, 3);
}

export type CloseCallHopPlan =
  | { kind: "free_per_car"; targets: string[] }
  | { kind: "tie_break"; targets: string[] }
  | { kind: "none" };

/**
 * What this hop should do before the normal chooser.
 * Free per-car checks on the tied cars come before the one paid tie-break.
 * No tie-break once one has been spent, or once the paid cap is reached.
 */
export function planCloseCallHop(input: {
  closeKeys: readonly string[];
  missingFreeKeys: readonly string[];
  freeGovOpen: boolean;
  consistencyOpen: boolean;
  tieBreakSpent: boolean;
  paidCallsSoFar: number;
  paidCap: number;
  keyed: boolean;
}): CloseCallHopPlan {
  if (!input.keyed || input.freeGovOpen || input.closeKeys.length < 2) return { kind: "none" };
  if (input.missingFreeKeys.length > 0) {
    return { kind: "free_per_car", targets: input.missingFreeKeys.slice(0, 3) };
  }
  if (input.consistencyOpen || input.tieBreakSpent) return { kind: "none" };
  if (input.paidCallsSoFar >= input.paidCap) return { kind: "none" };
  return { kind: "tie_break", targets: input.closeKeys.slice(0, 3) };
}

export function planCloseCallAfterHop(input: {
  closeCount: number;
  missingFree: number;
  freeGovOpen: boolean;
  consistencyOpen: boolean;
  tieBreakSpent: boolean;
  paidCalls: number;
  paidCap: number;
  keyed: boolean;
}): { continueFree: boolean; continueTieBreak: boolean; stopUnresolved: boolean } {
  const idle = { continueFree: false, continueTieBreak: false, stopUnresolved: false };
  if (input.closeCount < 2 || input.freeGovOpen) return idle;
  if (input.missingFree > 0 || input.consistencyOpen) {
    return { continueFree: true, continueTieBreak: false, stopUnresolved: false };
  }
  const canPay = input.keyed && !input.tieBreakSpent && input.paidCalls < input.paidCap;
  if (canPay) return { continueFree: false, continueTieBreak: true, stopUnresolved: false };
  return { continueFree: false, continueTieBreak: false, stopUnresolved: true };
}
