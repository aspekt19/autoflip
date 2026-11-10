/**
 * Map Deal Radar SERV activity rows into the shared Resale decision journal schema
 * so every Radar run shows the same user-facing journal as Resale search.
 */

import {
  appendJournalStep,
  emptyResaleJournal,
  RESALE_SERV_CALL_CAP,
  type ResaleDecisionJournal,
} from "./resale-decision-journal";

export type RadarActivityRow = {
  at: string;
  searchId: string;
  vin: string;
  profile: string;
  modelRequested: string;
  modelReported: string;
  responseId: string | null;
  latencyMs: number;
  ok: boolean;
  decision: string | null;
  note: string | null;
  alerted: boolean;
};

export function journalFromRadarActivity(
  rows: RadarActivityRow[],
  extras?: { notes?: string[]; startedAt?: string },
): ResaleDecisionJournal {
  let journal = emptyResaleJournal(Math.max(RESALE_SERV_CALL_CAP, 8));
  const recordedAt = extras?.startedAt ?? new Date().toISOString();

  if (rows.length === 0) {
    journal = appendJournalStep(journal, {
      kind: "stop_or_widen",
      actor: "code",
      decided: "No agent calls on this Radar run",
      why:
        extras?.notes?.[0] ??
        "No new good/fair candidates required a SERV step, or SERV was not configured. Alerts (if any) used code ratings only.",
      inputsUsed: [],
      changed: null,
      model: null,
      responseId: null,
      recordedAt,
      rejected: null,
    });
    return journal;
  }

  for (const row of rows) {
    const kind =
      row.profile === "verdict_challenge" || row.profile === "resale_challenge"
        ? "challenge"
        : row.profile === "radar_review" || row.profile === "flip_judge"
          ? "triage"
          : row.profile === "verdict_decide" || row.profile === "resale_pick"
            ? "pick"
            : "deep_check";
    journal = appendJournalStep(journal, {
      kind,
      actor: "SERV",
      decided: row.ok
        ? `${row.profile} → ${row.decision ?? (row.alerted ? "alert" : "skip")} for ${row.vin}`
        : `${row.profile} failed for ${row.vin}`,
      why: row.note?.trim() || (row.ok ? "Agent used code-computed facts only." : "Agent call failed or timed out."),
      inputsUsed: [`vin:${row.vin}`, `search:${row.searchId}`, `check:${row.profile}`],
      changed: null,
      model: row.modelReported || row.modelRequested || null,
      responseId: row.responseId,
      recordedAt: row.at || recordedAt,
      rejected: row.ok ? null : "rejected: unsupported reference",
    });
  }

  for (const note of extras?.notes ?? []) {
    if (!note.trim()) continue;
    journal = appendJournalStep(journal, {
      kind: "fallback",
      actor: "code",
      decided: "Run note",
      why: note,
      inputsUsed: [],
      changed: null,
      model: null,
      responseId: null,
      recordedAt,
      rejected: null,
    });
  }

  return journal;
}
