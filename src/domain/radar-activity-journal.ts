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
  /** Per-HTTP-invocation id (preferred for call counting). */
  callId?: string | null;
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

/** Stable key for one HTTP invocation (never falls back to per-VIN). */
export function radarHttpCallKey(row: RadarActivityRow): string {
  if (row.callId?.trim()) return `${row.profile}::call:${row.callId.trim()}`;
  if (row.responseId?.trim()) return `${row.profile}::${row.responseId.trim()}`;
  // Legacy rows: same profile + stamp + latency = one call (timeout of N cars stays one).
  return `${row.profile}::at:${row.at}::lat:${row.latencyMs}`;
}

/** Group activity rows that share one HTTP invocation. */
export function groupByHttpCall(rows: RadarActivityRow[]): RadarActivityRow[][] {
  const groups: RadarActivityRow[][] = [];
  const indexByKey = new Map<string, number>();
  for (const row of rows) {
    const key = radarHttpCallKey(row);
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

function decisionLabel(row: RadarActivityRow): string {
  if (row.decision === "alert" || row.decision === "skip") return row.decision;
  if (row.alerted) return "alert";
  if (row.decision == null || row.decision === "") return "no_decision";
  return row.decision;
}

/**
 * Prefer an honest empty-run reason over boilerplate notes like "prompt guard: allow"
 * or delivery config lines that are not why SERV was skipped.
 */
export function noAgentCallsWhy(notes?: string[] | null, filterBreakdown?: string | null): string {
  if (filterBreakdown?.trim()) {
    return `No new candidates needed a SERV step this run. Filters: ${filterBreakdown.trim()}`;
  }
  const meaningful = (notes ?? []).filter((note) => {
    const n = note.trim();
    if (!n) return false;
    if (/^prompt guard:/i.test(n)) return false;
    if (/^Email alerts are not configured/i.test(n)) return false;
    if (/^Telegram /i.test(n)) return false;
    return true;
  });
  const hit = meaningful.find((n) =>
    /already seen|no new|not due|No listings|candidates|Not reviewed|Flip explanation unavailable|AUTODEV/i.test(
      n,
    ),
  );
  if (hit) return hit;
  if (meaningful[0]) return meaningful[0];
  return "No new good/fair candidates needed a SERV step this run (all already seen, none passed filters, or SERV was not configured).";
}

export function journalFromRadarActivity(
  rows: RadarActivityRow[],
  extras?: { notes?: string[]; startedAt?: string; filterBreakdown?: string | null },
): ResaleDecisionJournal {
  let journal = emptyResaleJournal();
  const recordedAt = extras?.startedAt ?? new Date().toISOString();

  if (rows.length === 0) {
    journal = appendJournalStep(journal, {
      kind: "stop_or_widen",
      actor: "code",
      decided: "No agent calls on this Radar run",
      why: noAgentCallsWhy(extras?.notes, extras?.filterBreakdown),
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
    const skipCount = group.filter((row) => row.decision === "skip").length;
    const noDecisionCount = group.filter(
      (row) => decisionLabel(row) === "no_decision" && !row.alerted,
    ).length;
    const batched = group.length > 1;

    journal = appendJournalStep(journal, {
      kind,
      actor: "SERV",
      decided: batched
        ? `${head.profile} HTTP call — ${group.length} decisions (${alertCount} alert, ${skipCount} skip${
            noDecisionCount > 0 ? `, ${noDecisionCount} no_decision` : ""
          })`
        : head.ok
          ? `${head.profile} → ${decisionLabel(head)}${head.vin ? ` for ${head.vin}` : ""}`
          : `${head.profile} failed${head.vin ? ` for ${head.vin}` : ""}`,
      why: timedOut
        ? secs != null
          ? `SERV timed out after ${secs}s`
          : "SERV timed out"
        : batched
          ? `One batched HTTP response. Decisions: ${group
              .map((row) => `${row.vin}:${decisionLabel(row)}`)
              .join(", ")}.`
          : head.note?.trim() || (head.ok ? "Agent used code-computed facts only." : "Agent call failed."),
      inputsUsed: [
        ...[...new Set(group.flatMap((row) => (row.vin ? [`vin:${row.vin}`] : [])))],
        `search:${head.searchId}`,
        `check:${head.profile}`,
        ...(head.callId?.trim() ? [`call:${head.callId.trim()}`] : []),
        ...(batched ? [`http_decisions:${group.length}`] : []),
      ],
      changed: null,
      model: head.modelReported || head.modelRequested || null,
      responseId: head.responseId,
      recordedAt: head.at || recordedAt,
      rejected: head.ok
        ? null
        : timedOut || head.decision === "timeout"
          ? "timeout"
          : head.decision === "http_error" || head.decision === "error"
            ? head.decision
            : "http_error",
      countServCall: true,
    });

    if (batched) {
      for (const row of group) {
        const label = decisionLabel(row);
        const missing = label === "no_decision";
        journal = appendJournalStep(journal, {
          kind,
          actor: "SERV",
          decided: missing
            ? `${row.profile} → no decision for ${row.vin}`
            : `${row.profile} → ${label} for ${row.vin}`,
          why: missing
            ? row.note?.trim() || "No decision in this SERV response."
            : row.note?.trim() || "Decision from the batched HTTP response above.",
          inputsUsed: [`vin:${row.vin}`, `search:${row.searchId}`, `check:${row.profile}`],
          changed: null,
          model: row.modelReported || row.modelRequested || null,
          responseId: row.responseId,
          recordedAt: row.at || recordedAt,
          // HTTP succeeded for the batch — a missing VIN verdict is not an http_error.
          rejected: row.ok ? null : timedOut ? "timeout" : "http_error",
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

  // Soft display clamp for one Radar activity mapping only — not a Resale artificial call cap.
  // Real Radar limit remains the monthly plan SERV cap (plan-book), not this journal field.
  if (journal.servCalls > RADAR_SERV_CALL_CAP) {
    journal = { ...journal, servCalls: RADAR_SERV_CALL_CAP };
  }

  return journal;
}
