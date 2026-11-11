/**
 * Persist decision audit trails + aggregate SERV run stats.
 * Stats are derived only from sealed trails — never seeded with invented numbers.
 */

import {
  accumulateServRunStats,
  buildDecisionAuditTrail,
  emptyServRunAggregateStats,
  hashReport,
  type DecisionAuditTrail,
  type ServRunAggregateStats,
  verifyDecisionAuditTrail,
} from "@/domain/decision-audit-chain";
import {
  buildServDecisionJournal,
  type ServDecisionStep,
} from "@/domain/serv-decision-step";
import type { DecisionProofRecord } from "@/domain/decision-proof-view";
import type { FullReport } from "@/domain/types";
import type { Kv } from "./kv";
import { getKv } from "./kv";

const TRAIL_KEY = (reportId: string) => `decision-audit:${reportId}`;
const STATS_KEY = "decision-audit:stats:v1";
const INDEX_KEY = "decision-audit:index:v1";
const INDEX_LIMIT = 200;

function parseTrail(raw: string | null): DecisionAuditTrail | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as DecisionAuditTrail;
    if (!parsed || parsed.schemaVersion !== "lemonless.decision_audit_chain.v1") return null;
    if (!Array.isArray(parsed.links)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseStats(raw: string | null): ServRunAggregateStats {
  if (!raw) return emptyServRunAggregateStats();
  try {
    const parsed = JSON.parse(raw) as ServRunAggregateStats;
    if (!parsed || parsed.schemaVersion !== "lemonless.serv_run_stats.v1") {
      return emptyServRunAggregateStats();
    }
    return {
      schemaVersion: "lemonless.serv_run_stats.v1",
      trailCount: Number(parsed.trailCount) || 0,
      servCallCount: Number(parsed.servCallCount) || 0,
      codeStepCount: Number(parsed.codeStepCount) || 0,
      secondCheckAgreements: Number(parsed.secondCheckAgreements) || 0,
      secondCheckDisagreements: Number(parsed.secondCheckDisagreements) || 0,
      newestSealedAt: typeof parsed.newestSealedAt === "string" ? parsed.newestSealedAt : null,
    };
  } catch {
    return emptyServRunAggregateStats();
  }
}

async function readIndex(kv: Kv): Promise<string[]> {
  const raw = await kv.get(INDEX_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export async function saveDecisionAuditTrail(
  trail: DecisionAuditTrail,
  opts?: { secondCheckAgree?: boolean | null; kv?: Kv },
): Promise<{ saved: boolean; verifyOk: boolean }> {
  const verified = verifyDecisionAuditTrail(trail);
  if (!verified.ok) return { saved: false, verifyOk: false };

  const kv = opts?.kv ?? getKv();
  const existing = parseTrail(await kv.get(TRAIL_KEY(trail.reportId)));
  // Idempotent: same tip already stored.
  if (existing?.tipHash === trail.tipHash) {
    return { saved: true, verifyOk: true };
  }

  await kv.set(TRAIL_KEY(trail.reportId), JSON.stringify(trail));

  const index = await readIndex(kv);
  const nextIndex = [trail.reportId, ...index.filter((id) => id !== trail.reportId)].slice(
    0,
    INDEX_LIMIT,
  );
  await kv.set(INDEX_KEY, JSON.stringify(nextIndex));

  // Only count a brand-new report id toward aggregates (avoid double-count on overwrite).
  if (!existing) {
    const prior = parseStats(await kv.get(STATS_KEY));
    const next = accumulateServRunStats(prior, trail, {
      answersAgree: opts?.secondCheckAgree ?? null,
    });
    await kv.set(STATS_KEY, JSON.stringify(next));
  }

  return { saved: true, verifyOk: true };
}

export async function loadDecisionAuditTrail(
  reportId: string,
  kv: Kv = getKv(),
): Promise<DecisionAuditTrail | null> {
  return parseTrail(await kv.get(TRAIL_KEY(reportId)));
}

export async function loadServRunAggregateStats(
  kv: Kv = getKv(),
): Promise<ServRunAggregateStats> {
  return parseStats(await kv.get(STATS_KEY));
}

function stepsFromReport(report: FullReport, proofRecords?: readonly DecisionProofRecord[] | null): ServDecisionStep[] {
  return buildServDecisionJournal({
    proofRecords,
    agentVerdict: report.computed.agentVerdict,
  }).steps;
}

/** Seal + store an audit trail for a persisted FullReport. */
export async function sealAndStoreReportAudit(
  report: FullReport,
  opts?: { proofRecords?: readonly DecisionProofRecord[] | null; kv?: Kv },
): Promise<DecisionAuditTrail | null> {
  const steps = stepsFromReport(report, opts?.proofRecords);
  const trail = buildDecisionAuditTrail({
    reportId: report.id,
    reportHash: hashReport(report),
    steps,
    sealedAt: report.createdAt,
  });
  const second = report.computed.agentVerdict?.second_pass;
  const agree =
    second?.status === "agreed" ? true : second?.status === "disagreed" ? false : null;
  const result = await saveDecisionAuditTrail(trail, {
    secondCheckAgree: agree,
    kv: opts?.kv,
  });
  return result.saved ? trail : null;
}
