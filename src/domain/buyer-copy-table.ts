/**
 * Every shopper-facing verdict, failure reason, and journal sentence.
 * Callers render these strings. They do not assemble audit text and then scrub it.
 */

export const VERDICT_IDS = ["buy", "negotiate", "pass", "needs_inspection"] as const;
export type VerdictId = (typeof VERDICT_IDS)[number];

export const FAILURE_IDS = [
  "no_cars",
  "could_not_plan",
  "search_failed",
  "decision_failed",
  "second_check_incomplete",
  "not_enough_evidence",
  "no_qualifying_flip",
  "review_unavailable",
] as const;
export type FailureReasonId = (typeof FAILURE_IDS)[number];

export const JOURNAL_STEP_IDS = [
  "read_request",
  "plan_search",
  "search_listings",
  "compare_cars",
  "similar_cars",
  "recalls",
  "factory_details",
  "crash_tests",
  "choose_car",
  "second_check",
] as const;
export type JournalStepId = (typeof JOURNAL_STEP_IDS)[number];

export const SOURCE_IDS = [
  "cars_for_sale",
  "similar_cars",
  "government_recalls",
  "factory_details",
  "crash_tests",
  "owner_complaints",
] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

export type RunKind = "find" | "resale" | "check";
export type RunPhase = "draft" | "running" | "finished" | "stopped";
export type StepStatus = "ok" | "failed" | "skipped" | "running";
export type RunConfidence = "High" | "Medium" | "Low";

const VERDICT_COPY: Record<VerdictId, string> = {
  buy: "Buy",
  negotiate: "Fair price",
  pass: "Skip",
  needs_inspection: "Get it inspected first",
};

const FAILURE_COPY: Record<FailureReasonId, string> = {
  no_cars: "No cars matched this search, so there is no verdict and nothing was charged.",
  could_not_plan: "We could not plan this search.",
  search_failed: "The listing search did not finish.",
  decision_failed: "The decision did not finish.",
  second_check_incomplete: "The second check did not finish.",
  not_enough_evidence: "There is not enough information for a verdict.",
  no_qualifying_flip: "Skip. No car is estimated to sell within the window you set, or none was priced below similar listings after costs.",
  review_unavailable: "The review did not run, so confidence is Low.",
};

const JOURNAL_COPY: Record<JournalStepId, { title: string; ok: string; failed: string; skipped: string; running: string }> = {
  read_request: {
    title: "Read your request",
    ok: "We read your note and the details you added.",
    failed: "We could not read your request.",
    skipped: "We did not need to read the request again.",
    running: "We are reading your request.",
  },
  plan_search: {
    title: "Plan the search",
    ok: "We turned your request into a search for cars that fit.",
    failed: "We could not plan this search.",
    skipped: "Planning was skipped.",
    running: "We are planning the search.",
  },
  search_listings: {
    title: "Look for cars",
    ok: "We looked for cars for sale that match your limits.",
    failed: "The listing search did not finish.",
    skipped: "No listing search ran.",
    running: "We are looking for cars for sale.",
  },
  compare_cars: {
    title: "Compare the cars",
    ok: "We compared the cars that came back.",
    failed: "We could not finish comparing the cars.",
    skipped: "The cars were not compared.",
    running: "We are comparing the cars.",
  },
  similar_cars: {
    title: "Similar cars",
    ok: "We compared similar cars for sale nearby.",
    failed: "We could not compare similar cars for sale nearby.",
    skipped: "Similar cars for sale nearby were not compared.",
    running: "We are comparing similar cars for sale nearby.",
  },
  recalls: {
    title: "Recalls",
    ok: "We checked the government recall database.",
    failed: "The government recall database check did not finish.",
    skipped: "The government recall database was not checked.",
    running: "We are checking the government recall database.",
  },
  factory_details: {
    title: "Factory details",
    ok: "We read the car's factory details.",
    failed: "We could not read the car's factory details.",
    skipped: "The car's factory details were not read.",
    running: "We are reading the car's factory details.",
  },
  crash_tests: {
    title: "Crash tests",
    ok: "We checked crash-test ratings.",
    failed: "The crash-test rating check did not finish.",
    skipped: "Crash-test ratings were not checked.",
    running: "We are checking crash-test ratings.",
  },
  choose_car: {
    title: "Choose a car",
    ok: "We chose a car from the ones that matched.",
    failed: "We could not choose a car.",
    skipped: "No car was chosen.",
    running: "We are choosing a car.",
  },
  second_check: {
    title: "Second check",
    ok: "A second check reviewed that choice.",
    failed: "The second check did not finish.",
    skipped: "The second check did not run.",
    running: "A second check is reviewing that choice.",
  },
};

const SOURCE_COPY: Record<SourceId, string> = {
  cars_for_sale: "Cars for sale",
  similar_cars: "Similar cars for sale nearby",
  government_recalls: "Government recall database",
  factory_details: "The car's factory details",
  crash_tests: "Crash-test ratings",
  owner_complaints: "Owner complaints filed with the government",
};

const KIND_COPY: Record<RunKind, string> = {
  find: "Find a car",
  resale: "Resale search",
  check: "Vehicle check",
};

const PHASE_COPY: Record<RunPhase, string> = {
  draft: "This search has not started.",
  running: "This search is still running.",
  finished: "This search is finished.",
  stopped: "This search stopped before a verdict.",
};

/** Proof purpose → journal step. Unknown purposes are omitted, never printed. */
const PURPOSE_TO_STEP: Record<string, JournalStepId> = {
  need_extract: "read_request",
  need_guard: "read_request",
  find_plan: "plan_search",
  resale_plan_search: "plan_search",
  find_triage: "compare_cars",
  resale_triage: "compare_cars",
  facts_given: "factory_details",
  find_decide: "choose_car",
  find_pick: "choose_car",
  verdict_decide: "choose_car",
  resale_pick: "choose_car",
  find_challenge: "second_check",
  verdict_challenge: "second_check",
  resale_challenge: "second_check",
};

const CONFIDENCE_COPY: Record<RunConfidence, string> = {
  High: "High",
  Medium: "Medium",
  Low: "Low",
};

export function verdictCopy(id: VerdictId): string {
  return VERDICT_COPY[id];
}

export function failureCopy(id: FailureReasonId): string {
  return FAILURE_COPY[id];
}

export function journalStepCopy(id: JournalStepId, status: StepStatus): { title: string; sentence: string } {
  const row = JOURNAL_COPY[id];
  return { title: row.title, sentence: row[status] };
}

export function sourceCopy(id: SourceId): string {
  return SOURCE_COPY[id];
}

export function kindCopy(kind: RunKind): string {
  return KIND_COPY[kind];
}

export function phaseCopy(phase: RunPhase): string {
  return PHASE_COPY[phase];
}

export function confidenceCopy(value: RunConfidence): string {
  return CONFIDENCE_COPY[value];
}

export function journalStepForPurpose(purpose: string): JournalStepId | null {
  return PURPOSE_TO_STEP[purpose] ?? null;
}

export function isVerdictId(value: string): value is VerdictId {
  return (VERDICT_IDS as readonly string[]).includes(value);
}

export function isFailureReasonId(value: string): value is FailureReasonId {
  return (FAILURE_IDS as readonly string[]).includes(value);
}

export function isJournalStepId(value: string): value is JournalStepId {
  return (JOURNAL_STEP_IDS as readonly string[]).includes(value);
}

export function isSourceId(value: string): value is SourceId {
  return (SOURCE_IDS as readonly string[]).includes(value);
}

/** Map a pipeline action onto a verdict id. Unknown codes become no verdict. */
export function verdictIdFromRaw(value: string | null | undefined): VerdictId | null {
  if (!value) return null;
  const cleaned = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (cleaned === "buy" || cleaned === "good_deal") return "buy";
  if (cleaned === "negotiate" || cleaned === "fair") return "negotiate";
  if (cleaned === "pass" || cleaned === "skip" || cleaned === "overpriced" || cleaned === "walk_away") return "pass";
  if (cleaned === "needs_inspection" || cleaned === "insufficient_data") return "needs_inspection";
  return null;
}

export function confidenceFromRaw(value: string | null | undefined): RunConfidence | null {
  if (!value) return null;
  const cleaned = value.trim().toLowerCase();
  if (cleaned === "high") return "High";
  if (cleaned === "medium") return "Medium";
  if (cleaned === "low" || cleaned === "none") return "Low";
  return null;
}

/** Every sentence the table can show, for the jargon test. */
export function allBuyerCopySentences(): string[] {
  const out: string[] = [
    ...Object.values(VERDICT_COPY),
    ...Object.values(FAILURE_COPY),
    ...Object.values(SOURCE_COPY),
    ...Object.values(KIND_COPY),
    ...Object.values(PHASE_COPY),
    ...Object.values(CONFIDENCE_COPY),
  ];
  for (const row of Object.values(JOURNAL_COPY)) {
    out.push(row.title, row.ok, row.failed, row.skipped, row.running);
  }
  return out;
}
