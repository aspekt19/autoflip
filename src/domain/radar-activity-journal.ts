/**
 * Map Deal Radar SERV activity rows into the shared Resale decision journal schema
 * so every Radar run shows the same user-facing journal as Resale search.
 */

import { ASSUMPTIONS } from "./assumptions";
import {
  appendJournalStep,
  emptyResaleJournal,
  type ResaleDecisionJournal,
} from "./resale-decision-journal";

/** Guard + flip_feasibility + radar_review + personal decide/challenge slots. */
export const RADAR_SERV_CALL_CAP =
  1 + 2 + ASSUMPTIONS.radarMaxServPerSearch * 2;

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

function stepKind(profile: string): Parameters<typeof appendJournalStep>[1]["kind"] {
  if (profile === "verdict_challenge" || profile === "resale_challenge") return "challenge";
  if (profile === "radar_review" || profile === "flip_judge" || profile === "flip_feasibility") return "triage";
  if (profile === "verdict_decide" || profile === "resale_pick") return "pick";
  if (profile === "radar_guard") return "stop_or_widen";
  return "deep_check";
}

/** Group activity rows that share one HTTP response (same profile + response id). */
function groupByHttpCall(rows: RadarActivityRow[]): RadarActivityRow[][] {
  const groups: RadarActivityRow[][] = [];
  const indexByKey = new Map<string, number>();
  for (const row of rows) {
    const key =
      row.responseId && row.responseId.trim()
        ? `${row.profile}::${row.responseId.trim()}`
        : `${row.profile}::row:${groups.length}:${row.vin}`;
    const existing = indexByKey.get(key);
    if (existing != null) {
      groups[existing]!.push(row);
      continue;
    }
    indexByKey.set(key, groups.length);
    groups.push([row]);
  }
  return groups;
}

export function journalFromRadarActivity(
  rows: RadarActivityRow[],
  extras?: { notes?: string[]; startedAt?: string },
): ResaleDecisionJournal {
  let journal = emptyResaleJournal(RADAR_SERV_CALL_CAP);
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

  for (const group of groupByHttpCall(rows)) {
    const head = group[0]!;
    const kind = stepKind(head.profile);
    const timedOut =
      !head.ok &&
      (head.note?.toLowerCase().includes("timed out") ||
        head.note?.toLowerCase().includes("timeout") ||
        head.decision === "timeout");
    const secs = head.latencyMs > 0 ? Math.max(1, Math.round(head.latencyMs / 1000)) : null;
    const alertCount = group.filter((row) => row.decision === "alert" || row.alerted).length;
    const skipCount = group.filter((row) => row.decision === "skip" || (row.ok && !row.alerted && row.decision !== "alert")).length;
    const batched = group.length > 1 && Boolean(head.responseId?.trim());

    journal = appendJournalStep(journal, {
      kind,
      actor: "SERV",
      decided: batched
        ? `${head.profile} HTTP call — ${group.length} decisions (${alertCount} alert, ${skipCount} skip)`
        : head.ok
          ? `${head.profile} → ${head.decision ?? (head.alerted ? "alert" : "skip")}${head.vin ? ` for ${head.vin}` : ""}`
          : `${head.profile} failed${head.vin ? ` for ${head.vin}` : ""}`,
      why: timedOut
        ? secs != null
          ? `SERV timed out after ${secs}s`
          : "SERV timed out"
        : batched
          ? `One batched HTTP response. Decisions: ${group
              .map((row) => `${row.vin}:${row.decision ?? (row.alerted ? "alert" : "skip")}`)
              .join(", ")}.`
          : head.note?.trim() || (head.ok ? "Agent used code-computed facts only." : "Agent call failed."),
      inputsUsed: [
        ...[...new Set(group.flatMap((row) => (row.vin ? [`vin:${row.vin}`] : [])))],
        `search:${head.searchId}`,
        `check:${head.profile}`,
        ...(batched ? [`http_decisions:${group.length}`] : []),
      ],
      changed: null,
      model: head.modelReported || head.modelRequested || null,
      responseId: head.responseId,
      recordedAt: head.at || recordedAt,
      rejected: head.ok ? null : timedOut ? "timeout" : "http_error",
      countServCall: true,
    });

    if (batched) {
      for (const row of group) {
        journal = appendJournalStep(journal, {
          kind,
          actor: "SERV",
          decided: `${row.profile} → ${row.decision ?? (row.alerted ? "alert" : "skip")} for ${row.vin}`,
          why: row.note?.trim() || "Decision from the batched HTTP response above.",
          inputsUsed: [`vin:${row.vin}`, `search:${row.searchId}`, `check:${row.profile}`],
          changed: null,
          model: row.modelReported || row.modelRequested || null,
          responseId: row.responseId,
          recordedAt: row.at || recordedAt,
          rejected: row.ok ? null : "http_error",
          // Same HTTP call — do not inflate SERV call count.
          countServCall: false,
        });
      }
    }
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
