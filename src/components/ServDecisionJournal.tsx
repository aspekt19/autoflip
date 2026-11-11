"use client";

import type { AgentVerdict } from "@/domain/agent-verdict-schema";
import { agentSpend } from "@/domain/agent-verdict-view";
import type { DecisionProofRecord } from "@/domain/decision-proof-view";
import type { ResaleDecisionJournal } from "@/domain/resale-decision-journal";
import {
  formatJournalSecondCheckSentences,
  JOURNAL_INTRO,
  journalStepViews,
} from "@/domain/serv-decision-journal-copy";
import {
  buildServDecisionJournal,
  type ServDecisionJournalView,
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

function formatProvenance(input: {
  modelId: string | null;
  runId: string | null;
  timestamp: string | null;
}): string | null {
  const runId = providerResponseId(input.runId);
  const bits = [
    input.modelId ? `Model ${input.modelId}` : null,
    runId ? `response ${runId}` : null,
    input.timestamp
      ? new Date(input.timestamp).toLocaleString("en-US", { timeZone: "UTC" }) + " UTC"
      : null,
  ].filter(Boolean);
  return bits.length > 0 ? bits.join(" · ") : null;
}

/**
 * Readable "How this decision was made" journal.
 * Main view: plain buyer English + origin marker + real response id / timestamp when known.
 * Digests and hashes stay under "Technical details".
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
  const stepViews = journalStepViews(journal.steps);
  const secondSentences = formatJournalSecondCheckSentences(journal.secondCheck);
  const unknowns = agentVerdict?.unknowns ?? [];
  const spendNote = agentVerdict ? agentSpend(agentVerdict)?.costNote ?? "" : "";
  const examplePending =
    unknowns.some((line) => /example not yet recorded/i.test(line)) ||
    /example not yet recorded/i.test(spendNote);
  const agentUnavailable =
    unknowns.some((line) => /agent step unavailable/i.test(line)) ||
    /agent step unavailable/i.test(spendNote);
  const secondProvenance = formatProvenance({
    modelId: journal.secondCheck.modelId,
    runId: journal.secondCheck.runId,
    timestamp: null,
  });

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

      <p className="hint">{JOURNAL_INTRO}</p>

      {agentVerdict?.no_serv_step ? (
        <p className="lead">
          {agentUnavailable
            ? "The review step was unavailable — price rules only."
            : examplePending
              ? "Example not yet recorded. This sample page shows labeled listing economics only — it does not invent an agent revision or second check."
              : "This run did not use a SERV reasoning step. The ranking or verdict came from code checks only."}
        </p>
      ) : null}

      {stepViews.length === 0 && !agentVerdict?.no_serv_step ? (
        <p className="lead">No decision steps were recorded for this run.</p>
      ) : stepViews.length === 0 ? null : (
        <ol className="steps-3 story-steps">
          {stepViews.map((view, index) => {
            const provenance = formatProvenance(view.provenance);
            return (
              <li key={`${view.tech.step}-${view.tech.timestamp ?? index}-${view.tech.runId ?? view.tech.status}`}>
                <p>{view.sentences}</p>
                <p>
                  <strong>{view.originMarker}</strong>
                </p>
                {provenance ? <p className="hint">{provenance}</p> : null}
              </li>
            );
          })}
        </ol>
      )}

      <section aria-label="Second check">
        <p>{secondSentences}</p>
        {secondProvenance ? <p className="hint">{secondProvenance}</p> : null}
      </section>

      <details className="onboarding-note">
        <summary>Technical details</summary>
        {stepViews.length === 0 ? (
          <p className="hint">No step records to show.</p>
        ) : (
          <ol className="steps-3 story-steps">
            {stepViews.map((view, index) => {
              const runId = providerResponseId(view.tech.runId);
              return (
                <li key={`tech-${view.tech.step}-${index}`}>
                  <strong>
                    {view.by} · {view.tech.step} · {view.tech.status} · {view.tech.origin}
                  </strong>
                  <span className="hint">{view.tech.output}</span>
                  <span className="hint">{view.tech.inputSummary}</span>
                  {view.tech.originReason ? (
                    <span className="hint">Origin reason: {view.tech.originReason}</span>
                  ) : null}
                  <span className="hint">
                    {view.tech.modelId ? `Model ${view.tech.modelId}` : "Model not recorded"}
                    {runId ? ` · response ${runId}` : " · no response id"}
                    {view.tech.timestamp
                      ? ` · ${new Date(view.tech.timestamp).toLocaleString("en-US", { timeZone: "UTC" })} UTC`
                      : ""}
                    {typeof view.tech.latencyMs === "number" ? ` · ${view.tech.latencyMs} ms` : ""}
                    {typeof view.tech.costUsd === "number" ? ` · $${view.tech.costUsd.toFixed(4)}` : ""}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
        {journal.secondCheck.runId || journal.secondCheck.modelId ? (
          <p className="hint">
            Second check
            {journal.secondCheck.modelId ? ` · ${journal.secondCheck.modelId}` : ""}
            {journal.secondCheck.runId
              ? ` · response ${providerResponseId(journal.secondCheck.runId)}`
              : ""}
          </p>
        ) : null}
        {reportHash ? (
          <p className="hint">
            Report hash <span className="mono">{reportHash.slice(0, 16)}…</span>
          </p>
        ) : null}
        {verifyId ? (
          <p className="hint">
            <a href={`/verify?id=${encodeURIComponent(verifyId)}`}>Verify this decision trail</a>
          </p>
        ) : (
          <p className="hint">
            <a href="/verify">Verify a decision trail</a>
          </p>
        )}
      </details>
    </details>
  );
}
