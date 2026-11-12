/**
 * One validator for a stored Run — the same object GET /api/run/[id] returns.
 * A hard failure must not be published as a normal result.
 */
import { failureCopy, type FailureReasonId } from "./buyer-copy-table";
import { formatNumber, formatUsd } from "./format";
import { implausibleOdometer, implausibleOdometerReason } from "./find-best-deal";
import { isAwdDrivetrain } from "./find-car-consistency";
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
  reason?: string | null;
  confidence?: string | null;
  implausible?: boolean;
  drivetrainUnknown?: boolean;
  bodyUnknown?: boolean;
};

type PublicRun = {
  kind?: string;
  phase?: string;
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
};

const JARGON: Array<{ re: RegExp; label: string }> = [
  { re: /\b\d{2}V\d{6}\b/, label: "a raw recall campaign code" },
  { re: /\bprofitMid\b/, label: "profitMid" },
  { re: /\ballInCost\b/, label: "allInCost" },
  { re: /\bComputed:/, label: "Computed:" },
  { re: /cached for this search/i, label: "cached for this search" },
  { re: /\bThey want\b/, label: "They want" },
  { re: /Lemonless AI was unavailable/i, label: "Lemonless AI was unavailable" },
];

export function scrubBuyerText(value: string): string {
  let text = value.replace(/\s+/g, " ").trim();
  text = text.replace(/\b\d{2}V\d{6}\b/g, "a government safety recall");
  text = text.replace(/\bprofitMid\b/g, "the middle estimate");
  text = text.replace(/\ballInCost\b/g, "the total cost");
  text = text.replace(/\bComputed:\s*/g, "");
  text = text.replace(/Same decision cached for this search for 24 hours\.?/gi, "This is the saved result for these same filters.");
  text = text.replace(/\bThey want\b/g, "You want");
  text = text.replace(/Lemonless AI was unavailable\.?\s*/gi, "");
  const sentences = text.split(/(?<=[.!?])\s+/);
  const kept: string[] = [];
  for (const sentence of sentences) {
    const norm = sentence.trim().toLowerCase();
    if (!norm) continue;
    if (kept.length && kept[kept.length - 1]!.trim().toLowerCase() === norm) continue;
    kept.push(sentence.trim());
  }
  return kept.join(" ").replace(/\s+/g, " ").trim();
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

function check(id: string, pass: boolean, message: string): InvariantCheck {
  return { id, hard: true, pass, message };
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

export function checkRunInvariants(value: unknown): InvariantReport {
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
  const noVerdictCopy = /no credit was used|nothing was charged|not charged/i.test(text);

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
  const worth = /\bworth it\b/i.test(text) && !/not worth/i.test(text);
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
  const jargon = JARGON.find((item) => fields.some((field) => item.re.test(field)));
  const duplicated = fields.some((field) => {
    const sentences = field.split(/(?<=[.!?])\s+/).map((line) => line.trim().toLowerCase()).filter(Boolean);
    return sentences.some((line, index) => index > 0 && sentences[index - 1] === line);
  });
  checks.push(
    check(
      "plain-language",
      !jargon && !duplicated,
      jargon ? `Buyer text contains ${jargon.label}.` : duplicated ? "A sentence is repeated back to back." : "Buyer text is plain.",
    ),
  );

  return { ok: checks.every((item) => item.pass), checks };
}

function band(car: RunListing): number {
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

  if (!verdict) {
    creditsCharged = 0;
    confidence = null;
    confidenceReason = null;
    listings = listings.map((car) => ({ ...car, offerUsd: null, offerLabel: null }));
    if (!failureReasons.length) failureReasons = ["not_enough_evidence"];
    const honest = failureReasons.map((id) => failureCopy(id)).join(" ");
    if (!/no credit was used|nothing was charged/i.test(honest)) {
      buyerMessage = "No credit was used.";
    } else {
      buyerMessage = null;
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
      const gap = pick?.summary ?? buyerMessage ?? "";
      if (/priced below similar listings by \$/i.test(gap) && !/minimum that is worth the effort/i.test(gap)) {
        const extra = " It is still a pass because that amount is below the minimum that is worth the effort and time.";
        if (pick) pick.summary = scrubBuyerText(`${pick.summary ?? ""} ${extra}`);
        buyerMessage = scrubBuyerText(`${buyerMessage ?? ""} ${extra}`);
      }
    }
  }

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
  if (report.ok || !verdict) return settled;
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
