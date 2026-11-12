/**
 * One validator for a stored Run — the same object GET /api/run/[id] returns.
 * A hard failure must not be published as a normal result.
 */
import { failureCopy, JOURNAL_STEP_IDS, NO_DECISION_COPY, type FailureReasonId, type JournalStepId } from "./buyer-copy-table";
import { collapseRepeatedSentences, findRepeatedSentenceInHtml, joinBuyerParts, visibleHtmlText } from "./buyer-text";
import { formatNumber, formatUsd } from "./format";
import { implausibleOdometer, implausibleOdometerReason } from "./find-best-deal";
import { isAwdDrivetrain } from "./find-car-consistency";
import { registrationTaxSentence } from "./purchase-readiness";
import type { RunListing, RunRecord } from "./run";
import { yearSpanSentence } from "./year-span";

export const HIGH_MILES = 160_000;
const PRICE_SLACK = 1.05;

export type InvariantCheck = {
  id: string;
  hard: boolean;
  pass: boolean;
  message: string;
};

export type InvariantReport = {
  ok: boolean;
  checks: InvariantCheck[];
};

type Car = {
  vin: string;
  year: number;
  make: string;
  model: string;
  priceUsd: number | null;
  miles: number | null;
  picked?: boolean;
  summary?: string | null;
  drivetrain?: string | null;
  accidentCount?: number | null;
  bodyStyle?: string | null;
  offerUsd?: number | null;
  offerLabel?: string | null;
  state?: string | null;
  reason?: string | null;
  confidence?: string | null;
  implausible?: boolean;
  drivetrainUnknown?: boolean;
  bodyUnknown?: boolean;
};

type PublicStep = { step?: string; status?: string | null };

type PublicRun = {
  kind?: string;
  phase?: string;
  note?: string | null;
  verdict?: string | null;
  confidence?: string | null;
  confidenceReason?: string | null;
  creditsCharged?: number;
  failureReasons?: string[];
  limits?: string[];
  listings?: Car[];
  picks?: string[];
  buyerMessage?: string | null;
  message?: string | null;
  steps?: PublicStep[];
};

const JARGON: Array<{ re: RegExp; label: string }> = [
  { re: /\b\d{2}V\d{6}\b/, label: "a raw recall campaign code" },
  { re: /\bprofitMid\b/, label: "profitMid" },
  { re: /\ballInCost\b/, label: "allInCost" },
  { re: /\bComputed:/, label: "Computed:" },
  { re: /cached for this search/i, label: "cached for this search" },
  { re: /\bThey want\b/, label: "They want" },
  { re: /Lemonless AI was unavailable/i, label: "Lemonless AI was unavailable" },
  { re: /\(\s*[+-]\d+(?:\.\d+)?\s*\)/, label: "a parenthesised score delta" },
  { re: /Not scored for fairness/i, label: "Not scored for fairness" },
  { re: /treated as neutral/i, label: "treated as neutral" },
  { re: /\bPZEV\b|partial zero-emission|PARTIAL ZERO-EMISSION/i, label: "PZEV" },
  { re: /Trim names disagree/i, label: "Trim names disagree" },
  { re: /\bTechnical details\b/, label: "Technical details" },
  { re: /Stop-sale|park-until-fixed/i, label: "Stop-sale / park-until-fixed" },
  { re: /supplied VIN/i, label: "supplied VIN" },
];

const STEP_ORDER: JournalStepId[] = [...JOURNAL_STEP_IDS];

const COMPACT_OR_SEDAN = /corolla|civic|camry|accord|mazda3|elantra|sentra|jetta|impreza|malibu|sonata|altima/i;
const SUV_ONLY = /forester|rav4|cr-?v|tucson|cx-5|equinox|sportage|crosstrek|escape|rogue/i;

export function scrubBuyerText(value: string): string {
  let text = value.replace(/\s+/g, " ").trim();
  text = text.replace(/\b\d{2}V\d{6}\b/g, "a government safety recall");
  text = text.replace(/\bprofitMid\b/g, "the middle estimate");
  text = text.replace(/\ballInCost\b/g, "the total cost");
  text = text.replace(/\bComputed:\s*/g, "");
  text = text.replace(/Same decision cached for this search for 24 hours\.?/gi, "This is the saved result for these same filters.");
  text = text.replace(/\bThey want\b/g, "You want");
  text = text.replace(/Lemonless AI was unavailable\.?\s*/gi, "");
  text = text.replace(/\(\s*[+-]\d+(?:\.\d+)?\s*\)/g, "");
  text = text.replace(/Not scored for fairness\s*[—-]\s*/gi, "");
  text = text.replace(/asking-price comparison is treated as neutral\s*/gi, "");
  text = text.replace(/treated as neutral/gi, "");
  text = text.replace(/\bpartial\s+zero[-\s]?emission\b/gi, "");
  text = text.replace(/\bPZEV\b/gi, "");
  text = text.replace(
    /Stop-sale\s*\/\s*park-until-fixed recall guidance is open for this year and model(?:\s*[—-]\s*not eligible as the published pick)?\.?/gi,
    "The maker says don't drive it until the recall repair is done, so this car is not the one to buy.",
  );
  text = text.replace(
    /the supplied VIN decode references a different vehicle/gi,
    "the listing's VIN decodes to a different model, ask the seller",
  );
  return collapseRepeatedSentences(text);
}

function asRun(value: unknown): PublicRun | null {
  if (!value || typeof value !== "object") return null;
  const row = value as { run?: unknown };
  const source = row.run && typeof row.run === "object" ? (row.run as PublicRun) : (value as PublicRun);
  if (!source || typeof source !== "object") return null;
  return source;
}

function moneyToNumber(raw: string): number {
  return Number(raw.replace(/,/g, ""));
}

function dollarsIn(text: string): number[] {
  const out: number[] = [];
  const re = /\$([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) out.push(moneyToNumber(match[1]!));
  return out;
}

function limitsOf(run: PublicRun) {
  const lines = run.limits ?? [];
  const blob = lines.join(" ");
  const price = blob.match(/Budget up to \$([0-9,]+)/);
  const miles = blob.match(/No more than ([0-9,]+) miles/);
  const oldest = blob.match(/Oldest year (\d{4})/);
  const newest = blob.match(/Newest year (\d{4})/);
  const span = blob.match(/Years (\d{4})[–-](\d{4})/);
  const exact = blob.match(/\bYear (\d{4})\b/);
  const body = blob.match(/Body type ([^.]+)\./);
  return {
    priceMax: price ? moneyToNumber(price[1]!) : null,
    milesMax: miles ? moneyToNumber(miles[1]!) : null,
    yearMin: oldest ? Number(oldest[1]) : span ? Number(span[1]) : exact ? Number(exact[1]) : null,
    yearMax: newest ? Number(newest[1]) : span ? Number(span[2]) : exact ? Number(exact[1]) : null,
    drivetrain: /all-wheel drive or four-wheel drive/i.test(blob),
    body: body ? body[1]!.trim().toLowerCase() : null,
  };
}

function chargeLine(credits: number): string {
  if (credits <= 0) return "No credit was used.";
  return credits === 1 ? "1 credit was used." : `${credits} credits were used.`;
}

function buyerFields(run: PublicRun): string[] {
  const cars = run.listings ?? [];
  const parts = [
    run.buyerMessage,
    run.message,
    run.confidenceReason,
    chargeLine(run.creditsCharged ?? 0),
    ...(run.failureReasons ?? []).map((id) => (isKnownFailure(id) ? failureCopy(id) : id)),
    ...(run.limits ?? []),
    ...cars.flatMap((car) => [car.summary, car.reason, car.offerLabel]),
  ];
  return parts.filter((line): line is string => typeof line === "string" && line.trim().length > 0);
}

function buyerBlob(run: PublicRun): string {
  return buyerFields(run).join(" ");
}

function isKnownFailure(id: string): id is FailureReasonId {
  return (
    id === "no_cars" ||
    id === "could_not_plan" ||
    id === "search_failed" ||
    id === "decision_failed" ||
    id === "second_check_incomplete" ||
    id === "not_enough_evidence" ||
    id === "no_qualifying_flip" ||
    id === "review_unavailable"
  );
}

/**
 * Hard checks block a published verdict: a limit was broken, a charge has no
 * verdict, or an implausible car was picked. Soft checks stay visible to the
 * checker and do not throw away a decision the model already made.
 */
const HARD_CHECK_IDS = new Set(["record", "no-verdict-charge", "hard-limits", "implausible"]);

function check(id: string, pass: boolean, message: string): InvariantCheck {
  return { id, hard: HARD_CHECK_IDS.has(id), pass, message };
}

function fits(car: Car, limits: ReturnType<typeof limitsOf>): boolean {
  if (limits.priceMax != null && car.priceUsd != null && car.priceUsd > limits.priceMax * PRICE_SLACK) return false;
  if (limits.milesMax != null && car.miles != null && car.miles > limits.milesMax) return false;
  if (limits.yearMin != null && car.year > 0 && car.year < limits.yearMin) return false;
  if (limits.yearMax != null && car.year > limits.yearMax) return false;
  return true;
}

function dirty(car: Car): boolean {
  return (car.accidentCount ?? 0) > 0 || (car.miles ?? 0) >= HIGH_MILES;
}

function offerDollars(car: Car): boolean {
  if (typeof car.offerUsd === "number" && car.offerUsd > 0) return true;
  return /opening offer:\s*\$/i.test(`${car.offerLabel ?? ""} ${car.summary ?? ""}`);
}

function stepOrderProblem(steps: PublicStep[] | undefined, html: string | null): string | null {
  const titles = ["Read your request", "Plan the search", "Look for cars", "Compare the cars", "Choose a car", "Second check"];
  if (html) {
    const visible = visibleHtmlText(html);
    const found = titles
      .map((title) => ({ title, index: visible.indexOf(title) }))
      .filter((row) => row.index >= 0);
    for (let i = 1; i < found.length; i += 1) {
      const prev = found[i - 1]!;
      const next = found[i]!;
      if (next.index < prev.index) return `${prev.title} is listed after ${next.title}.`;
    }
  }
  const ids = (steps ?? []).map((row) => row.step).filter((step): step is string => Boolean(step));
  const rank = new Map(STEP_ORDER.map((id, index) => [id, index]));
  let prev = -1;
  for (const id of ids) {
    const index = rank.get(id as JournalStepId);
    if (index == null) continue;
    if (index < prev) return `${id} is after a step that should follow it.`;
    prev = index;
  }
  return null;
}

function starterMixProblem(run: PublicRun): string | null {
  const note = run.note ?? "";
  if (!/\b(?:first car|new driver)\b/i.test(note)) return null;
  const models = (run.listings ?? []).map((car) => car.model).filter(Boolean);
  if (models.length < 2) return null;
  if (models.some((model) => COMPACT_OR_SEDAN.test(model))) return null;
  if (models.every((model) => SUV_ONLY.test(model))) {
    return "A first-car search returned only SUVs. Compact sedans and hatchbacks should be in the mix.";
  }
  return null;
}

function fairValueAboveAsk(text: string, ask: number): boolean {
  const re = /fair value \$([0-9,]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    if (moneyToNumber(match[1]!) > ask) return true;
  }
  return false;
}

export function checkRunInvariants(value: unknown, html?: string | null): InvariantReport {
  const run = asRun(value);
  const checks: InvariantCheck[] = [];
  if (!run) {
    checks.push(check("record", false, "The response is not a run."));
    return { ok: false, checks };
  }
  const verdict = typeof run.verdict === "string" && run.verdict.trim() ? run.verdict.trim().toLowerCase() : null;
  const credits = typeof run.creditsCharged === "number" && run.creditsCharged > 0 ? run.creditsCharged : 0;
  const cars = Array.isArray(run.listings) ? run.listings : [];
  const picks = Array.isArray(run.picks) ? run.picks : [];
  const limits = limitsOf(run);
  const text = buyerBlob(run);
  const noVerdictCopy = /no credit was used|nothing was charged|not charged|no charge/i.test(text);

  checks.push(
    check(
      "no-verdict-charge",
      verdict != null || (credits === 0 && noVerdictCopy && !cars.some(offerDollars)),
      verdict
        ? "A verdict is present."
        : credits > 0
          ? `No verdict, but ${credits} credit was charged.`
          : cars.some(offerDollars)
            ? "No verdict, but an opening offer amount is shown."
            : noVerdictCopy
              ? "No verdict, no charge, and the result says so."
              : "No verdict, but the result does not say that no credit was used.",
    ),
  );

  const header = run.confidence ?? null;
  const cardLevels = cars.map((car) => car.confidence).filter((level): level is string => Boolean(level));
  const reason = (run.confidenceReason ?? "").trim();
  const confidenceOk =
    verdict == null
      ? header == null
      : header === "High" || header === "Medium" || header === "Low"
        ? reason.length > 12 && cardLevels.every((level) => level.toLowerCase() === header.toLowerCase())
        : false;
  checks.push(
    check(
      "confidence-one",
      confidenceOk,
      verdict == null
        ? header
          ? "There is no verdict, but a confidence is still shown."
          : "No verdict, so no confidence is shown."
        : !header
          ? "A verdict is missing its confidence."
          : reason.length <= 12
            ? `Confidence is ${header} with no reason sentence.`
            : cardLevels.some((level) => level.toLowerCase() !== header.toLowerCase())
              ? `A card says ${cardLevels.find((level) => level.toLowerCase() !== header.toLowerCase())} while the result says ${header}.`
              : `One confidence, ${header}, with a reason.`,
    ),
  );

  const passLike = verdict === "pass" || verdict === "skip" || (run.failureReasons ?? []).includes("no_qualifying_flip");
  const worth = /\bworth it\b/i.test(text) && !/not worth|no flip worth it/i.test(text);
  const bestFlip = passLike && /best flip/i.test(text);
  const picked = cars.find((car) => car.picked) ?? cars.find((car) => picks.includes(car.vin)) ?? null;
  const cardText = picked
    ? [picked.summary, picked.reason, picked.offerLabel, picked.priceUsd != null ? `$${picked.priceUsd}` : ""]
        .filter(Boolean)
        .join(" ")
    : "";
  const quoted = dollarsIn(`${run.buyerMessage ?? ""} ${run.message ?? ""} ${picked?.summary ?? ""}`);
  const cardDollars = new Set(dollarsIn(cardText));
  const missingNumber = quoted.find((amount) => cardText && !cardDollars.has(amount));
  const positiveGap = passLike && /priced below similar listings by \$/i.test(text);
  const statesThreshold = /minimum that is worth the effort/i.test(text);
  checks.push(
    check(
      "verdict-label",
      !worth && !bestFlip && missingNumber == null && (!positiveGap || statesThreshold),
      worth
        ? "A pass or skip is written as worth it."
        : bestFlip
          ? "A pass or skip is labeled as a best flip."
          : missingNumber != null
            ? `The result quotes $${missingNumber.toLocaleString("en-US")}, which is not the number on the card.`
            : positiveGap && !statesThreshold
              ? "A pass shows a positive gap without saying the minimum that would be worth the effort."
              : "The verdict and the card use the same numbers and the same label.",
    ),
  );

  const limitProblems: string[] = [];
  for (const car of cars) {
    const name = `${car.year} ${car.make} ${car.model}`.trim();
    if (limits.priceMax != null && (car.priceUsd == null || car.priceUsd > limits.priceMax * PRICE_SLACK)) {
      limitProblems.push(`${name} is over the budget.`);
    }
    if (limits.milesMax != null && (car.miles == null || car.miles > limits.milesMax)) {
      limitProblems.push(`${name} is over the mileage limit.`);
    }
    if (limits.yearMin != null && car.year > 0 && car.year < limits.yearMin) limitProblems.push(`${name} is older than ${limits.yearMin}.`);
    if (limits.yearMax != null && car.year > limits.yearMax) limitProblems.push(`${name} is newer than the year limit.`);
    if (limits.drivetrain && !isAwdDrivetrain(car.drivetrain) && !car.drivetrainUnknown) {
      limitProblems.push(`${name} does not show all-wheel drive.`);
    }
    if (limits.body && car.bodyStyle && !car.bodyStyle.toLowerCase().includes(limits.body.split(" ")[0] ?? limits.body) && !car.bodyUnknown) {
      limitProblems.push(`${name} is not the requested body type.`);
    }
  }
  checks.push(
    check(
      "hard-limits",
      limitProblems.length === 0,
      limitProblems[0] ?? "Every shown car is inside the stated limits.",
    ),
  );

  const rankProblems: string[] = [];
  cars.forEach((car, index) => {
    if (!dirty(car) || car.implausible || !fits(car, limits)) return;
    const cleaner = cars.find(
      (other, otherIndex) =>
        otherIndex > index &&
        fits(other, limits) &&
        !other.implausible &&
        (other.accidentCount ?? 0) === 0 &&
        other.miles != null &&
        car.miles != null &&
        other.miles < car.miles &&
        other.miles < HIGH_MILES,
    );
    if (cleaner) {
      rankProblems.push(
        `${car.year} ${car.make} ${car.model} (${car.miles?.toLocaleString("en-US") ?? "?"} miles) ranks above a cleaner lower-mileage car.`,
      );
    }
  });
  checks.push(
    check("rank-clean", rankProblems.length === 0, rankProblems[0] ?? "No dirtier car ranks above a cleaner one that also fits."),
  );

  const odd = cars.filter((car) => implausibleOdometer(car.year, car.miles) && !car.implausible);
  checks.push(
    check(
      "implausible",
      odd.length === 0,
      odd[0]
        ? `${odd[0].year} ${odd[0].make} ${odd[0].model} has ${odd[0].miles?.toLocaleString("en-US")} miles and is not flagged.`
        : "Implausible readings are flagged or left out.",
    ),
  );

  const thin = verdict
    ? picks.filter((vin) => {
        const car = cars.find((row) => row.vin === vin);
        return !car || !(car.reason?.trim() || car.summary?.trim());
      })
    : [];
  checks.push(
    check(
      "same-story",
      thin.length === 0,
      thin.length
        ? "A published pick has no reason on the stored run, so the permalink cannot match the live page."
        : "Picks on this run carry the reason the page shows.",
    ),
  );

  const fields = buyerFields(run);
  const duplicated = fields.some((field) => {
    const sentences = field.split(/(?<=[.!?])\s+/).map((line) => line.trim().toLowerCase()).filter(Boolean);
    return sentences.some((line, index) => index > 0 && sentences[index - 1] === line);
  });
  const visible = html ? visibleHtmlText(html) : "";
  const jargonHits = JARGON.filter((item) => {
    if (fields.some((field) => item.re.test(field))) return true;
    if (!visible || item.label === "They want") return false;
    return item.re.test(visible);
  });
  const repeated = html ? findRepeatedSentenceInHtml(html) : null;
  checks.push(
    check(
      "plain-language",
      jargonHits.length === 0 && !duplicated,
      jargonHits.length
        ? `Buyer text contains ${jargonHits.map((item) => item.label).join(", ")}.`
        : duplicated
          ? "A sentence is repeated back to back."
          : "Buyer text is plain.",
    ),
  );

  checks.push(
    check(
      "repeated-text",
      !repeated,
      repeated ? `The page repeats “${repeated.sentence.slice(0, 80)}”.` : "The page does not repeat a sentence.",
    ),
  );

  const orderProblem = stepOrderProblem(run.steps, html ?? null);
  checks.push(
    check("step-order", !orderProblem, orderProblem ?? "The decision steps are in order, with the search before the choice."),
  );

  const mixProblem = starterMixProblem(run);
  checks.push(check("starter-mix", !mixProblem, mixProblem ?? "A first-car search includes more than one body type, or this is not a first-car search."));

  const suppliedVin = /supplied VIN/i.test(text) || (html ? /supplied VIN/i.test(visible) : false);
  checks.push(
    check(
      "vin-mismatch",
      !suppliedVin,
      suppliedVin
        ? "A VIN decode mismatch is written as if the shopper supplied a VIN."
        : "VIN mismatches, when named, are about the listing's VIN.",
    ),
  );

  const choiceFinished = (run.steps ?? []).some((step) => step.step === "choose_car" && step.status !== "failed" && step.status !== "skipped");
  const evaluatedCopy =
    cars.some((car) => /still a pass|priced \$[0-9,]+ under similar/i.test(`${car.reason ?? ""} ${car.summary ?? ""}`)) ||
    /not enough information for a verdict|did not meet the checks for a published verdict/i.test(`${text} ${visible}`);
  const resaleDeadEnd = run.kind === "resale" && cars.length > 0 && !verdict && choiceFinished && evaluatedCopy;
  checks.push(
    check(
      "evaluated-verdict",
      !resaleDeadEnd,
      resaleDeadEnd
        ? "Every shown car was evaluated, so this is a verdict (no flip worth it, with the closest car), not a search that stopped."
        : "A search with evaluated cars has a verdict, or it did not evaluate them.",
    ),
  );

  const pickedCar = cars.find((car) => car.picked) ?? cars.find((car) => picks.includes(car.vin)) ?? cars[0] ?? null;
  const firstOffer = visible.match(/Opening offer:\s*([^.]{0,120})/i);
  const offerNotGiven = Boolean(firstOffer && /not given/i.test(firstOffer[1] ?? ""));
  const finishedFind = run.kind === "find" && verdict != null && pickedCar?.priceUsd != null;
  checks.push(
    check(
      "offer-rendered",
      !(finishedFind && offerNotGiven),
      offerNotGiven
        ? "The permalink's top pick says the opening offer was not given."
        : "The top pick's opening offer is on the page, or this page has no opening-offer line.",
    ),
  );

  const askEqualsOffer =
    finishedFind &&
    pickedCar != null &&
    pickedCar.offerUsd != null &&
    pickedCar.priceUsd != null &&
    pickedCar.offerUsd === pickedCar.priceUsd &&
    fairValueAboveAsk(`${text} ${visible}`, pickedCar.priceUsd);
  checks.push(
    check(
      "offer-at-ask",
      !askEqualsOffer,
      askEqualsOffer
        ? "The opening offer equals the asking price even though fair value is higher."
        : "An opening offer is not the asking price when the car is under fair value.",
    ),
  );

  const buyerState = /\bchicago\b/i.test(run.note ?? "")
    ? "Illinois"
    : /\bdenver\b/i.test(run.note ?? "")
      ? "Colorado"
      : /\bdallas\b/i.test(run.note ?? "")
        ? "Texas"
        : null;
  const stateCode = buyerState === "Illinois" ? "IL" : buyerState === "Colorado" ? "CO" : buyerState === "Texas" ? "TX" : null;
  const otherState = stateCode != null && cars.some((car) => car.state && car.state.toUpperCase() !== stateCode);
  const namesBuyerState = buyerState != null && new RegExp(buyerState, "i").test(`${text} ${visible}`);
  checks.push(
    check(
      "tax-state",
      !otherState || namesBuyerState,
      otherState && !namesBuyerState
        ? `A car is listed in another state, and the page does not say sales tax assumes ${buyerState}, where you would register.`
        : "Sales tax, when a car is in another state, names the state we assumed.",
    ),
  );

  const compared = (run.steps ?? []).some((step) => step.step === "compare_cars" && step.status === "ok");
  const deniesComparison = /asking prices were not compared/i.test(`${text} ${visible}`);
  checks.push(
    check(
      "comparison-honest",
      !(compared && cars.length > 0 && deniesComparison),
      deniesComparison
        ? "The result says asking prices were not compared, but the comparison step finished."
        : "The summary matches the comparison that actually ran.",
    ),
  );

  const savedReplay = /saved result for these same filters|same decision cached/i.test(`${text} ${visible}`);
  const honestReplay = /No credit used, same result as your search at /i.test(`${text} ${visible}`);
  const claimsCharge = credits > 0 || /credit was used/i.test(visible);
  checks.push(
    check(
      "charge-ledger",
      !(savedReplay && claimsCharge) && !(honestReplay && credits > 0),
      savedReplay && claimsCharge
        ? "A saved replay says a credit was used, but a replay of the same search is not a new charge."
        : "A replay does not claim a charge that did not happen.",
    ),
  );
  checks.push(
    check(
      "stale-cache",
      !savedReplay,
      savedReplay
        ? "The page is a saved result from an older search, without saying it is the same result as the earlier search."
        : "This page is not serving a stale saved result.",
    ),
  );

  const safetyNote = verdict != null && /\b(safe|safety|new driver|first car)\b/i.test(run.note ?? "");
  const oldSafety = cars.filter((car) => car.year > 0 && car.year < 2012);
  const safetyExplained = /electronic stability control|before 2012/i.test(`${text} ${visible}`);
  const safetyProblem = safetyNote && oldSafety.length > 0 && !safetyExplained;
  checks.push(
    check(
      "safety-year",
      !safetyProblem,
      safetyProblem
        ? `${oldSafety[0]!.year} ${oldSafety[0]!.make} ${oldSafety[0]!.model} is listed for a safety-oriented search without saying why cars from before 2012 were ranked lower.`
        : "A safety-oriented search explains older cars, or this is not one.",
    ),
  );

  const stopIndex = cars.findIndex((car) => DO_NOT_DRIVE.test(`${car.reason ?? ""} ${car.summary ?? ""}`));
  checks.push(
    check(
      "do-not-drive",
      stopIndex < 0 || stopIndex === cars.length - 1,
      stopIndex >= 0
        ? "A car with an open do-not-drive recall is still listed above cars without that warning."
        : "An open do-not-drive recall is ranked last and flagged, or none is shown.",
    ),
  );

  const drivetrainLine = /Drivetrain:\s*(?:FWD|RWD|AWD|4WD)/i.test(visible);
  const technicalLabel = html ? /<summary>\s*Technical details\s*<\/summary>/i.test(html) : false;
  const jargonBits = [
    drivetrainLine ? "a repeated Drivetrain line" : null,
    technicalLabel ? "a Technical details label" : null,
  ].filter(Boolean);
  checks.push(
    check(
      "buyer-jargon",
      jargonBits.length === 0,
      jargonBits.length
        ? `Buyer-facing page still has ${jargonBits.join(" and ")}.`
        : "Buyer-facing lines do not repeat the drivetrain label or a raw Technical details heading.",
    ),
  );

  if (html && pickedCar) {
    const offerAmount = typeof pickedCar.offerUsd === "number" && pickedCar.offerUsd > 0 ? formatUsd(pickedCar.offerUsd) : null;
    const missingOffer = offerAmount != null && !visible.includes(offerAmount);
    const reasonBit = pickedCar.reason?.trim();
    const missingReason = Boolean(reasonBit && reasonBit.length > 24 && !visible.toLowerCase().includes(reasonBit.slice(0, 24).toLowerCase()));
    checks.push(
      check(
        "same-story-html",
        !missingOffer && !missingReason,
        missingOffer
          ? `The stored opening offer ${offerAmount} is not on the permalink.`
          : missingReason
            ? "The stored pick reason is not on the permalink."
            : "The permalink shows the stored offer and the pick reason.",
      ),
    );
  }

  return { ok: checks.every((item) => item.pass), checks };
}

const DO_NOT_DRIVE = /don't drive it until the recall repair is done/i;

function band(car: RunListing): number {
  if (DO_NOT_DRIVE.test(`${car.reason ?? ""} ${car.summary ?? ""}`)) return 4;
  if (car.implausible) return 2;
  if ((car.accidentCount ?? 0) > 0 || (car.miles ?? 0) >= HIGH_MILES) return 1;
  return 0;
}

/**
 * Last step before a run is saved as finished or stopped.
 * A hard miss becomes an honest stop: no verdict and no charge.
 */
function publishedLimits(run: RunRecord): string[] {
  const spec = run.spec;
  if (!spec) return [];
  const lines: string[] = [];
  const price = spec.hard.priceMaxUsd?.value;
  if (price != null) lines.push(`Budget up to ${formatUsd(price)}.`);
  const years = yearSpanSentence(spec.hard.yearMin?.value, spec.hard.yearMax?.value);
  if (years) lines.push(years.endsWith(".") ? years : `${years}.`);
  const miles = spec.hard.milesMax?.value;
  if (miles != null) lines.push(`No more than ${formatNumber(miles)} miles.`);
  if (spec.hard.drivetrain?.value === "awd_4wd") lines.push("All-wheel drive or four-wheel drive.");
  const bodies = spec.hard.bodyStyles?.value ?? [];
  if (bodies.length) lines.push(`Body type ${bodies.join(" or ")}.`);
  return lines;
}

export function settlePublishedRun(run: RunRecord): RunRecord {
  if (run.phase === "running" || run.phase === "draft") return run;
  const limits = limitsOf({ limits: publishedLimits(run) });
  let listings = run.listings.map((car) => ({ ...car }));
  const hiddenOdd = listings.filter((car) => implausibleOdometer(car.year, car.miles)).length;
  listings = listings.filter((car) => !implausibleOdometer(car.year, car.miles));
  listings = listings.filter((car) => {
    if (limits.priceMax != null && car.priceUsd != null && car.priceUsd > limits.priceMax * PRICE_SLACK) return false;
    if (limits.milesMax != null && car.miles != null && car.miles > limits.milesMax) return false;
    if (limits.yearMin != null && car.year > 0 && car.year < limits.yearMin) return false;
    if (limits.yearMax != null && car.year > limits.yearMax) return false;
    if (limits.drivetrain && car.drivetrain && !isAwdDrivetrain(car.drivetrain)) return false;
    return true;
  });
  listings = listings.map((car) => {
    const odd = implausibleOdometer(car.year, car.miles);
    const drivetrainUnknown = Boolean(limits.drivetrain && !isAwdDrivetrain(car.drivetrain));
    const reasonBits = [car.reason?.trim() || null];
    if (odd && car.miles != null) reasonBits.push(implausibleOdometerReason(car.year, car.miles));
    if (drivetrainUnknown) reasonBits.push("Drivetrain is not listed, so all-wheel drive is not confirmed.");
    return {
      ...car,
      implausible: odd || car.implausible === true,
      drivetrainUnknown,
      reason: scrubBuyerText(reasonBits.filter(Boolean).join(" ")),
      summary: car.summary ? scrubBuyerText(car.summary) : car.summary,
      offerLabel: car.offerLabel ? scrubBuyerText(car.offerLabel) : car.offerLabel,
    };
  });
  listings.sort((a, b) => band(a) - band(b));
  listings = listings.map((car) => {
    const summary = car.summary?.trim() ?? "";
    const reason = car.reason?.trim() ?? "";
    if (summary && reason && reason.toLowerCase().includes(summary.toLowerCase().slice(0, Math.min(40, summary.length)))) {
      return { ...car, summary: null };
    }
    return car;
  });
  listings = listings.map((car) => {
    if (car.priceUsd == null || car.offerUsd == null || car.offerUsd !== car.priceUsd) return car;
    if (!fairValueAboveAsk(`${car.reason ?? ""} ${car.summary ?? ""} ${buyerBlob({ buyerMessage: run.buyerMessage })}`, car.priceUsd)) return car;
    const opening = Math.max(1, car.priceUsd - Math.max(100, Math.round(car.priceUsd * 0.03)));
    return {
      ...car,
      offerUsd: opening,
      offerLabel: scrubBuyerText(`Fairly priced or better; offering a little less is reasonable, e.g. ${formatUsd(opening)}.`),
    };
  });

  let verdict = run.verdict;
  let confidence = run.confidence;
  let picks = [...run.picks];
  let creditsCharged = run.creditsCharged;
  let failureReasons = [...run.failureReasons];
  let confidenceReason = run.confidenceReason ? scrubBuyerText(run.confidenceReason) : null;
  let buyerMessage = run.buyerMessage ? scrubBuyerText(run.buyerMessage) : null;

  const usable = listings.filter((car) => !car.implausible);
  if (verdict && picks[0] && !usable.some((car) => car.vin === picks[0])) {
    picks = usable[0] ? [usable[0].vin] : [];
    if (!picks.length) verdict = null;
  }
  if (verdict && picks[0]) {
    const top = usable[0];
    const picked = listings.find((car) => car.vin === picks[0]);
    if (top && picked && band(picked) > band(top)) {
      picks = [top.vin];
      const line = "A cleaner, lower-mileage car that also fits is the one to look at first.";
      top.reason = scrubBuyerText([top.reason, line].filter(Boolean).join(" "));
    }
  }

  const vinFlag = /listing's VIN decodes to a different model|supplied VIN/i;
  if (verdict && picks[0]) {
    const picked = listings.find((car) => car.vin === picks[0]);
    const flagged = picked && vinFlag.test(`${picked.reason ?? ""} ${picked.summary ?? ""}`);
    const other = flagged ? listings.find((car) => car.vin !== picked!.vin && !vinFlag.test(`${car.reason ?? ""} ${car.summary ?? ""}`) && !car.implausible) : null;
    if (picked && other) {
      picks = [other.vin];
      other.reason = scrubBuyerText(
        [other.reason, "A car whose listing VIN decodes to a different model was set aside. Ask the seller before relying on that listing."].filter(Boolean).join(" "),
      );
    }
  }

  const passCars = listings.filter((car) => /still a pass|priced .+ under similar|not worth/i.test(`${car.reason ?? ""} ${car.summary ?? ""}`));
  if (!verdict && run.kind === "resale" && passCars.length > 0) {
    const gapOf = (car: RunListing) => {
      const match = `${car.summary ?? ""} ${car.reason ?? ""}`.match(/\$([0-9,]+)/);
      return match ? moneyToNumber(match[1]!) : 0;
    };
    const closest = [...passCars].sort((a, b) => gapOf(b) - gapOf(a))[0]!;
    verdict = "pass";
    picks = [closest.vin];
    confidence = "Low";
    confidenceReason = "Low: every car was priced, and none clears the minimum that is worth the effort.";
    failureReasons = failureReasons.filter((id) => id !== "not_enough_evidence");
    listings = listings.map((car) => ({ ...car, confidence: "Low" }));
    const name = `${closest.year} ${closest.make} ${closest.model}`.trim();
    buyerMessage = scrubBuyerText(`No flip worth it here. Closest is the ${name}. ${closest.reason ?? closest.summary ?? ""}`);
  }

  if (!verdict) {
    creditsCharged = 0;
    confidence = null;
    confidenceReason = null;
    listings = listings.map((car) => ({
      ...car,
      offerUsd: null,
      offerLabel: null,
      picked: false,
      reason: car.reason && !/best choice/i.test(car.reason) ? car.reason : null,
    }));
    const decisionMissed = failureReasons.includes("decision_failed") || run.steps.some((step) => step.step === "choose_car" && step.status === "failed");
    if (decisionMissed && listings.length > 0) {
      failureReasons = failureReasons.filter((id) => id === "decision_failed" || id === "second_check_incomplete");
      if (!failureReasons.includes("decision_failed")) failureReasons = ["decision_failed", ...failureReasons];
      buyerMessage = NO_DECISION_COPY;
    } else {
      if (!failureReasons.length) failureReasons = ["not_enough_evidence"];
      const honest = failureReasons.map((id) => failureCopy(id)).join(" ");
      const oddNote = hiddenOdd > 0 ? `${hiddenOdd} listing${hiddenOdd === 1 ? " was" : "s were"} hidden because the mileage does not look believable.` : "";
      if (!/no credit was used|nothing was charged|no charge/i.test(honest)) {
        buyerMessage = joinBuyerParts(["No credit was used.", oddNote]);
      } else {
        buyerMessage = oddNote || null;
      }
    }
  } else {
    if (!confidence) confidence = "Low";
    if (!confidenceReason || confidenceReason.length < 12) {
      confidenceReason =
        confidence === "High"
          ? "High: the checks that finished agree on this car."
          : confidence === "Medium"
            ? "Medium: some checks are solid and some are still incomplete."
            : "Low: a check is missing or the evidence is thin, so this is not a firm read.";
    }
    const pick = listings.find((car) => car.vin === picks[0]);
    if (pick && !(pick.reason?.trim() || pick.summary?.trim())) {
      pick.reason = buyerMessage || confidenceReason;
    }
    if (run.kind === "resale" && (verdict === "pass" || failureReasons.includes("no_qualifying_flip"))) {
      const gap = pick?.summary ?? pick?.reason ?? buyerMessage ?? "";
      if (/priced below similar listings by \$|priced \$[0-9,]+ under similar/i.test(gap) && !/minimum that is worth the effort|no flip worth it/i.test(`${gap} ${buyerMessage ?? ""}`)) {
        const extra = " It is still a pass because that amount is below the minimum that is worth the effort and time.";
        if (pick && pick.summary) pick.summary = scrubBuyerText(`${pick.summary} ${extra}`);
        buyerMessage = scrubBuyerText(`${buyerMessage ?? ""} ${extra}`);
      }
      if (pick) {
        const name = `${pick.year} ${pick.make} ${pick.model}`.trim();
        const card = (pick.reason || pick.summary || "").trim();
        const replay = (buyerMessage ?? "").match(/No credit used, same result as your search at [^.]+?\./i)?.[0] ?? null;
        buyerMessage = joinBuyerParts([replay, `No flip worth it here. Closest is the ${name}.`, card]);
      }
    }
  }

  if (/No credit used, same result as your search at /i.test(buyerMessage ?? "")) {
    creditsCharged = 0;
  }

  const tax = registrationTaxSentence(run.spec?.hard.zip?.value ?? null, listings.map((car) => car.state ?? null));
  if (tax) buyerMessage = joinBuyerParts([buyerMessage, tax]);

  const settled: RunRecord = {
    ...run,
    listings,
    picks,
    verdict,
    confidence,
    creditsCharged,
    failureReasons,
    confidenceReason,
    buyerMessage,
    phase: verdict ? "finished" : "stopped",
  };
  const report = checkRunInvariants({
    verdict: settled.verdict,
    confidence: settled.confidence,
    confidenceReason: settled.confidenceReason,
    creditsCharged: settled.creditsCharged,
    failureReasons: settled.failureReasons,
    limits: publishedLimits(settled),
    listings: settled.listings.map((car) => ({ ...car, picked: settled.picks.includes(car.vin) })),
    picks: settled.picks,
    buyerMessage: settled.buyerMessage,
    kind: settled.kind,
  });
  const publishBlockers = HARD_CHECK_IDS;
  const blocking = report.checks.some((item) => !item.pass && publishBlockers.has(item.id));
  if (!blocking || !verdict) return settled;
  return {
    ...settled,
    verdict: null,
    confidence: null,
    confidenceReason: null,
    creditsCharged: 0,
    picks: [],
    phase: "stopped",
    listings: listings.map((car) => ({ ...car, offerUsd: null, offerLabel: null })),
    failureReasons: failureReasons.includes("not_enough_evidence") ? failureReasons : [...failureReasons, "not_enough_evidence"],
    buyerMessage: "This result did not meet the checks for a published verdict. No credit was used.",
  };
}
