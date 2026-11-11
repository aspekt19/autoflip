/**
 * Seal helpers for Find / Check / Resale delivery paths that are not FullReport.
 * Full reports are sealed inside `persistReport` → `sealAndStoreReportAudit`.
 *
 * Plug-in: call `sealRunDecisionAudit` after a Find/Resale/Check delivery that
 * stores proofRecords but is not a FullReport (sibling producers).
 */

import {
  buildDecisionAuditTrail,
  type DecisionAuditTrail,
} from "@/domain/decision-audit-chain";
import {
  buildServDecisionJournal,
  type ServDecisionStep,
} from "@/domain/serv-decision-step";
import type { DecisionProofRecord } from "@/domain/decision-proof-view";
import type { AgentVerdict } from "@/domain/agent-verdict-schema";
import type { ResaleDecisionJournal } from "@/domain/resale-decision-journal";
import { saveDecisionAuditTrail } from "@/io/decision-audit-store";
import { produceStepsFromProofRecords } from "@/server/serv/decision-step-producer";
import { sha256Canonical } from "@/domain/hash";

export function stepsForReportSeal(input: {
  proofRecords?: readonly DecisionProofRecord[] | null;
  agentVerdict?: AgentVerdict | null;
  resaleJournal?: ResaleDecisionJournal | null;
}): ServDecisionStep[] {
  const fromProof = produceStepsFromProofRecords(input.proofRecords);
  if (fromProof.length > 0) return fromProof;
  return buildServDecisionJournal({
    proofRecords: input.proofRecords,
    agentVerdict: input.agentVerdict,
    resaleJournal: input.resaleJournal,
  }).steps;
}

/** Seal an audit trail for a non-report run id (Find / Resale / Check delivery). */
export async function sealRunDecisionAudit(input: {
  runId: string;
  /** Canonical payload for the run hash (numbers + verdict fields only). */
  runPayload: unknown;
  proofRecords?: readonly DecisionProofRecord[] | null;
  agentVerdict?: AgentVerdict | null;
  resaleJournal?: ResaleDecisionJournal | null;
  sealedAt?: string;
}): Promise<DecisionAuditTrail | null> {
  const steps = stepsForReportSeal({
    proofRecords: input.proofRecords,
    agentVerdict: input.agentVerdict,
    resaleJournal: input.resaleJournal,
  });
  const trail = buildDecisionAuditTrail({
    reportId: input.runId,
    reportHash: sha256Canonical(input.runPayload),
    steps,
    sealedAt: input.sealedAt,
  });
  const second = input.agentVerdict?.second_pass;
  const agree =
    second?.status === "agreed" ? true : second?.status === "disagreed" ? false : null;
  const result = await saveDecisionAuditTrail(trail, { secondCheckAgree: agree });
  return result.saved ? trail : null;
}
