"use client";

import type { ReactNode } from "react";
import type { AgentVerdict } from "@/domain/agent-verdict-schema";
import { agentSecondCheck } from "@/domain/agent-verdict-view";
import {
  consumerDecisionSummaryLines,
  type DecisionProofRecord,
} from "@/domain/decision-proof-view";
import { AgentDecisionTrail } from "@/components/AgentDecisionTrail";
import { DecisionRecordList } from "@/components/DecisionRecord";

type Props = {
  records?: readonly DecisionProofRecord[] | null;
  verdict?: AgentVerdict | null;
  plainLines?: readonly string[] | null;
  emptyHint?: string | null;
  confidenceWhy?: string | null;
  savedRunAt?: string | null;
  proofExtra?: ReactNode;
};

function plainLinesFromVerdict(verdict: AgentVerdict | null | undefined): string[] {
  if (!verdict) return [];
  const lines: string[] = [];
  if (verdict.pick?.label) {
    lines.push(`Our AI picked this car because: ${verdict.pick.label}`);
  } else if (verdict.verdict) {
    lines.push(`Our AI’s review: ${verdict.verdict}`);
  }
  const second = agentSecondCheck(verdict);
  if (second?.status === "agreed") lines.push("Second AI review agreed.");
  else if (second?.status === "disagreed") {
    const action =
      second.action === "needs_inspection" ? "needs inspection" : second.action ?? null;
    lines.push(
      `Second AI review disagreed${action ? ` and chose ${action}` : ""}.${
        second.objection ? ` ${second.objection}` : ""
      }`,
    );
  }
  return lines;
}

/**
 * One consumer decision surface for Find / Check / Resale:
 * plain English in the main view, full ids/models/timestamps/raw behind a single Show proof.
 */
export function ConsumerDecisionProof({
  records = null,
  verdict = null,
  plainLines = null,
  emptyHint = null,
  confidenceWhy = null,
  savedRunAt = null,
  proofExtra = null,
}: Props) {
  const fromRecords = consumerDecisionSummaryLines(records);
  const fromVerdict = plainLinesFromVerdict(verdict);
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const line of [
    ...(Array.isArray(plainLines) ? plainLines.filter((row) => row.trim()) : []),
    ...fromVerdict,
    ...fromRecords,
  ]) {
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  const hasProof =
    (Array.isArray(records) && records.length > 0) || Boolean(verdict) || Boolean(proofExtra);

  if (lines.length === 0 && !hasProof) {
    return emptyHint ? <p className="hint">{emptyHint}</p> : null;
  }

  return (
    <section className="consumer-decision-proof" aria-label="How we decided">
      {lines.length > 0 ? (
        <ul className="refuse">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {hasProof ? (
        <details className="onboarding-note">
          <summary>
            <strong>Show proof</strong>
            <span className="hint"> — response ids, models, timestamps, and raw agent replies</span>
          </summary>
          <DecisionRecordList records={records} mode="proof" />
          <AgentDecisionTrail
            verdict={verdict}
            mode="proof"
            confidenceWhy={confidenceWhy}
            savedRunAt={savedRunAt}
          />
          {proofExtra}
        </details>
      ) : null}
    </section>
  );
}
