"use client";

import type { AgentVerdict } from "@/domain/agent-verdict-schema";
import { agentSpend } from "@/domain/agent-verdict-view";
import type { DecisionProofRecord } from "@/domain/decision-proof-view";
import type { ResaleDecisionJournal } from "@/domain/resale-decision-journal";
import {
  buildServDecisionJournal,
  type ServDecisionJournalView,
  type ServDecisionStep,
} from "@/domain/serv-decision-step";
import { providerResponseId } from "@/domain/serv-response-id";

type Props = {
  proofRecords?: readonly DecisionProofRecord[] | null;
  agentVerdict?: AgentVerdict | null;
  resaleJournal?: ResaleDecisionJournal | null;
  /** Pre-built journal when the caller already adapted steps. */
  journal?: ServDecisionJournalView | null;
  defaultOpen?: boolean;
  /** Report / run id for the verify link. */
  verifyId?: string | null;
  reportHash?: string | null;
};

function statusLabel(status: ServDecisionStep["status"]): string {
  switch (status) {
    case "ran":
      return "Ran";
    case "skipped":
      return "Skipped";
    case "failed":
      return "Failed";
    case "not_run":
      return "Did not run";
  }
}

/**
 * Readable "How this decision was made" journal.
 * Each step is marked SERV or code. Numbers are never attributed to SERV.
 * Missing steps say so plainly — no template placeholders shown as real.
 */
export function ServDecisionJournal({
  proofRecords,
  agentVerdict,
  resaleJournal,
  journal: journalProp,
  defaultOpen = false,
  verifyId = null,
  reportHash = null,
}: Props) {
  const journal =
    journalProp ??
    buildServDecisionJournal({ proofRecords, agentVerdict, resaleJournal });
  const steps = journal.steps;
  const second = journal.secondCheck;
  const unknowns = agentVerdict?.unknowns ?? [];
  const spendNote = agentVerdict ? agentSpend(agentVerdict)?.costNote ?? "" : "";
  const examplePending =
    unknowns.some((line) => /example not yet recorded/i.test(line)) ||
    /example not yet recorded/i.test(spendNote);
  const agentUnavailable =
    unknowns.some((line) => /agent step unavailable/i.test(line)) ||
    /agent step unavailable/i.test(spendNote);

  return (
    <details className="agent-decision-trail onboarding-note serv-decision-journal" open={defaultOpen}>
      <summary>
        <strong>{journal.title}</strong>
        {journal.servUsed ? (
          <span className="hint"> · SERV reasoning used</span>
        ) : (
          <span className="hint"> · Code checks only</span>
        )}
      </summary>

      <p className="hint">
        Dollar amounts and scores come from code. SERV reasoning may choose an action and explain it; it only quotes
        those numbers. Both answers must agree on the second check, or confidence drops.
      </p>

      {agentVerdict?.no_serv_step ? (
        <p className="lead">
          {agentUnavailable
            ? "Agent step unavailable — price rules only."
            : examplePending
              ? "Example not yet recorded. This sample page shows labeled listing economics only — it does not invent an agent revision or second check."
              : "This run did not use a SERV reasoning step. The ranking or verdict came from code checks only."}
        </p>
      ) : null}

      {steps.length === 0 && !agentVerdict?.no_serv_step ? (
        <p className="lead">No decision steps were recorded for this run.</p>
      ) : steps.length === 0 ? null : (
        <ol className="steps-3 story-steps">
          {steps.map((step, index) => {
            const runId = providerResponseId(step.runId);
            return (
              <li key={`${step.step}-${step.timestamp ?? index}-${runId ?? step.status}`}>
                <strong>
                  [{step.by}] {step.step.replace(/_/g, " ")} — {statusLabel(step.status)}
                </strong>
                <span>{step.output}</span>
                <span className="hint">{step.inputSummary}</span>
                {step.by === "SERV" ? (
                  <span className="hint">
                    {step.modelId ? `Model ${step.modelId}` : "Model not recorded"}
                    {runId ? ` · response ${runId}` : " · no response id"}
                    {step.timestamp
                      ? ` · ${new Date(step.timestamp).toLocaleString("en-US", { timeZone: "UTC" })} UTC`
                      : ""}
                    {typeof step.latencyMs === "number" ? ` · ${step.latencyMs} ms` : ""}
                    {typeof step.costUsd === "number" ? ` · $${step.costUsd.toFixed(4)}` : ""}
                  </span>
                ) : (
                  <span className="hint">
                    Code verified this step (numbers stay in TypeScript)
                    {step.timestamp
                      ? ` · ${new Date(step.timestamp).toLocaleString("en-US", { timeZone: "UTC" })} UTC`
                      : ""}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}

      <section aria-label="Second check">
        <h3>Second check</h3>
        {second.answersAgree === true ? (
          <p>Both answers agreed.{second.runId ? ` Response ${providerResponseId(second.runId)}.` : ""}</p>
        ) : null}
        {second.answersAgree === false ? (
          <p className="warn">{second.detail}</p>
        ) : null}
        {second.answersAgree == null ? <p>{second.detail}</p> : null}
      </section>

      {verifyId || reportHash ? (
        <p className="hint">
          {reportHash ? (
            <>
              Report hash <span className="mono">{reportHash.slice(0, 16)}…</span>
              {" · "}
            </>
          ) : null}
          {verifyId ? (
            <a href={`/verify?id=${encodeURIComponent(verifyId)}`}>Verify this decision trail</a>
          ) : (
            <a href="/verify">Verify a decision trail</a>
          )}
        </p>
      ) : (
        <p className="hint">
          <a href="/verify">Public verify</a> checks a sealed report hash and hash-linked decision chain.
        </p>
      )}
    </details>
  );
}
