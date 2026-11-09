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

export const CHECKS_FINISHED_NOTE = "Checks finished — no clear winner yet.";
export const PICK_SETTLED_NOTE = "Pick settled.";
export const CHECKS_STILL_RUNNING_NOTE = "Checks are still running. The pick may change.";

const FACTOR_PLAIN: Record<BestDealFactorId, string> = {
  price_vs_model_asks: "asking price versus similar listings",
  miles_per_year_vs_peers: "miles for its age",
  age: "model year and wear",
  estimated_fuel_cost: "fuel cost",
  mmy_recall_campaigns: "recall record",
  mmy_ncap_rating: "crash-test rating",
  named_model_preference: "how it matches what you asked for",
  budget_fit: "budget fit",
  condition_priority: "condition checks",
  listing_feed_flags: "listing warnings",
  days_listed: "time on the market",
};

function scrubDetail(detail: string): string {
  return detail
    .replace(/lower score for condition risk:\s*/gi, "Condition risk: ")
    .replace(/\bis scored lower\b/gi, "ranks lower")
    .replace(/\bscore\b/gi, "rating")
    .replace(/\s+/g, " ")
    .trim();
}

function detailSentences(detail: string): string[] {
  return scrubDetail(detail)
    .split(/(?<=\.)\s+/)
    .map((sentence) => sentence.replace(/\.$/, "").trim())
    .filter(Boolean);
}

function clipSentence(sentence: string): string {
  if (sentence.length <= 160) return sentence;
  return sentence.slice(0, 157).replace(/\s+\S*$/, "").trim();
}

/** The first sentence that is not the same on both cars. Identical openings hide the real difference. */
function differingDetails(leadDetail: string, otherDetail: string): { lead: string; other: string } {
  const lead = detailSentences(leadDetail);
  const other = detailSentences(otherDetail);
  const count = Math.max(lead.length, other.length);
  for (let index = 0; index < count; index += 1) {
    const leadBit = lead[index] ?? "";
    const otherBit = other[index] ?? "";
    if (leadBit !== otherBit) return { lead: clipSentence(leadBit), other: clipSentence(otherBit) };
  }
  return { lead: clipSentence(lead[0] ?? ""), other: clipSentence(other[0] ?? "") };
}

/** One plain reason the first car leads. Cites the check that actually separates them. No internal scores. */
export function closeCallLeadReason(
  first: BestDealCandidate,
  second: BestDealCandidate,
  labelOf: (car: BestDealCandidate) => string,
): string {
  const lead = labelOf(first);
  const other = labelOf(second);
  let best: { id: BestDealFactorId; delta: number; leadDetail: string; otherDetail: string } | null = null;
  for (const factor of first.factors) {
    const otherFactor = second.factors.find((row) => row.id === factor.id);
    const delta = factor.points - (otherFactor?.points ?? 0);
    if (delta <= 0) continue;
    if (!best || delta > best.delta) {
      best = {
        id: factor.id,
        delta,
        leadDetail: factor.detail,
        otherDetail: otherFactor?.detail ?? "",
      };
    }
  }
  if (best) {
    const bits = differingDetails(best.leadDetail, best.otherDetail);
    const leadBit = bits.lead ? ` ${bits.lead}.` : "";
    const compared = bits.other ? ` Compared with the ${other}: ${bits.other}.` : "";
    return `${lead} is ahead on ${FACTOR_PLAIN[best.id]}.${leadBit}${compared}`
      .replace(/\s+/g, " ")
      .replace(/\.{2,}/g, ".")
      .trim();
  }
  if (first.priceUsd != null && second.priceUsd != null && first.priceUsd < second.priceUsd) {
    return `${lead} asks $${first.priceUsd.toLocaleString("en-US")}, less than the ${other} at $${second.priceUsd.toLocaleString("en-US")}.`;
  }
  if (first.miles != null && second.miles != null && first.miles < second.miles) {
    return `${lead} has ${first.miles.toLocaleString("en-US")} miles, fewer than the ${other} at ${second.miles.toLocaleString("en-US")} miles.`;
  }
  return `The checks we ran do not separate the ${lead} from the ${other}.`;
}

function namedQuestion(question: string, car: BestDealCandidate, name: string): string {
  const title = `${car.year} ${car.make} ${car.model}`;
  const clean = question.replace(/\s+/g, " ").trim();
  if (!clean) return "";
  if (clean.includes(title)) return clean.replaceAll(title, name);
  if (clean.includes(name)) return clean;
  return `For the ${name}: ${clean}`;
}

/** One to three specific actions. The leaning car's own questions come first. No internal scores. */
export function whatWouldDecideCloseCall(
  cars: readonly BestDealCandidate[],
  labelOf: (car: BestDealCandidate) => string,
): string[] {
  const actions: string[] = [];
  const push = (line: string) => {
    if (actions.length >= 3 || !line) return;
    if (!actions.includes(line)) actions.push(line);
  };
  for (const car of cars) {
    const name = labelOf(car);
    for (const question of car.sellerQuestions) push(namedQuestion(question, car, name));
  }
  const names = cars.slice(0, 2).map((car) => labelOf(car));
  if (names.length >= 2) push(`A history report on the ${names[0]} and the ${names[1]}.`);
  else if (names[0]) push(`A history report on the ${names[0]}.`);
  if (names[0]) push(`A pre-purchase inspection of the ${names[0]}.`);
  return actions.slice(0, 3);
}

/** While another check is still going to run, do not say the checks finished or the pick settled. */
export function copyWhileChecksContinue<T extends { settlementNote: string; why: string }>(
  deal: T,
  continuing: boolean,
): T {
  if (!continuing) return deal;
  if (deal.settlementNote !== CHECKS_FINISHED_NOTE && deal.settlementNote !== PICK_SETTLED_NOTE) return deal;
  return {
    ...deal,
    settlementNote: CHECKS_STILL_RUNNING_NOTE,
    why: deal.why
      .replaceAll(CHECKS_FINISHED_NOTE, CHECKS_STILL_RUNNING_NOTE)
      .replaceAll(PICK_SETTLED_NOTE, CHECKS_STILL_RUNNING_NOTE),
  };
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
