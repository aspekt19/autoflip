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
  /** Hard cap for this surface (documented). */
  servCallCap: number;
};

export const RESALE_SERV_CALL_CAP = 6;

export function emptyResaleJournal(cap = RESALE_SERV_CALL_CAP): ResaleDecisionJournal {
  return {
    schemaVersion: "lemonless.resale_journal.v1",
    steps: [],
    servCalls: 0,
    servCallCap: cap,
  };
}

export function appendJournalStep(
  journal: ResaleDecisionJournal,
  step: Omit<ResaleJournalStep, "id"> & { id?: string },
): ResaleDecisionJournal {
  const id = step.id ?? `step_${journal.steps.length + 1}`;
  return {
    ...journal,
    steps: [...journal.steps, { ...step, id }],
    // Count every SERV HTTP attempt, including rejected payloads (they still spent budget).
    servCalls: step.actor === "SERV" ? journal.servCalls + 1 : journal.servCalls,
  };
}
