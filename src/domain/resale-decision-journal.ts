/**
 * User-facing decision journal for Resale search and Deal Radar runs.
 * Every step records a SERV (or code) decision with provenance — never invented content.
 */

export type ResaleJournalActor = "SERV" | "code";

export type ResaleJournalStepKind =
  | "plan_search"
  | "triage"
  | "deep_check"
  | "reject"
  | "rank"
  | "pick"
  | "challenge"
  | "stop_or_widen"
  | "fallback";

export type ResaleJournalStep = {
  id: string;
  kind: ResaleJournalStepKind;
  actor: ResaleJournalActor;
  /** What was decided. */
  decided: string;
  /** Why — must not invent numbers; cite evidence ids. */
  why: string;
  /** Inputs / evidence ids considered. */
  inputsUsed: string[];
  /** Highlight when the pick or shortlist changed. */
  changed: string | null;
  model: string | null;
  responseId: string | null;
  recordedAt: string;
  /** Present when SERV output was rejected by code validation. */
  rejected: string | null;
};

export type ResaleDecisionJournal = {
  schemaVersion: "lemonless.resale_journal.v1";
  steps: ResaleJournalStep[];
  /** Paid SERV calls recorded for this run. */
  servCalls: number;
};

export function emptyResaleJournal(): ResaleDecisionJournal {
  return {
    schemaVersion: "lemonless.resale_journal.v1",
    steps: [],
    servCalls: 0,
  };
}

export function appendJournalStep(
  journal: ResaleDecisionJournal,
  step: Omit<ResaleJournalStep, "id"> & {
    id?: string;
    /**
     * When false, a SERV step is recorded but does not increment servCalls
     * (e.g. per-VIN decisions from one batched HTTP response).
     * Default: count SERV actors as one HTTP call each.
     */
    countServCall?: boolean;
  },
): ResaleDecisionJournal {
  const id = step.id ?? `step_${journal.steps.length + 1}`;
  const { countServCall, ...rest } = step;
  const counts = rest.actor === "SERV" && countServCall !== false;
  return {
    ...journal,
    steps: [...journal.steps, { ...rest, id }],
    // Count real SERV HTTP attempts (including rejected payloads). Never count
    // batched per-VIN decision rows as separate calls.
    servCalls: counts ? journal.servCalls + 1 : journal.servCalls,
  };
}
