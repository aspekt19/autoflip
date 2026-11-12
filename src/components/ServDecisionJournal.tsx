"use client";

import type { AgentVerdict } from "@/domain/agent-verdict-schema";
import { agentSpend } from "@/domain/agent-verdict-view";
import type { DecisionProofRecord } from "@/domain/decision-proof-view";
import type { ResaleDecisionJournal } from "@/domain/resale-decision-journal";
import {
  formatJournalSecondCheckSentences,
  JOURNAL_INTRO,
  collapseRepeatedStepViews,
  journalStepViews,
} from "@/domain/serv-decision-journal-copy";
import {
  buildServDecisionJournal,
  type ServDecisionJournalView,
} from "@/domain/serv-decision-step";
import { plainDecisionEngineText } from "@/domain/find-buyer-copy";
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

/**
 * Readable "How this decision was made" journal.
 * Main view: plain buyer English. Response ids, models, and hashes stay under Technical details.
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
  const shownSteps = collapseRepeatedStepViews(stepViews);
  const secondSentences = formatJournalSecondCheckSentences(journal.secondCheck);
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
          <span className="hint"> · a review step ran</span>
        ) : (
          <span className="hint"> · calculated checks only</span>
        )}
      </summary>

      <p className="hint">{plainDecisionEngineText(JOURNAL_INTRO)}</p>

      {agentVerdict?.no_serv_step ? (
        <p className="lead">
          {agentUnavailable
            ? "The review step was unavailable — price rules only."
            : examplePending
              ? "Example not yet recorded. This sample page shows labeled listing economics only — it does not invent an agent revision or second check."
              : "This run did not use a review step. The ranking or verdict came from calculated checks only."}
        </p>
      ) : null}

      {shownSteps.length === 0 && !agentVerdict?.no_serv_step ? (
        <p className="lead">No decision steps were recorded for this run.</p>
      ) : shownSteps.length === 0 ? null : (
        <ol className="steps-3 story-steps">
          {shownSteps.map((view, index) => {
            return (
              <li key={`${view.tech.step}-${view.tech.timestamp ?? index}-${view.tech.runId ?? view.tech.status}`}>
                <p>{plainDecisionEngineText(view.sentences)}</p>
                {view.originMarker ? <p className="hint">{view.originMarker}</p> : null}
              </li>
            );
          })}
        </ol>
      )}

      <section aria-label="Second check">
        <p>{plainDecisionEngineText(secondSentences)}</p>
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
            <a href={`/verify?id=${encodeURIComponent(verifyId)}`}>Check this saved decision</a>
          </p>
        ) : (
          <p className="hint">
            <a href="/verify">Check a saved decision</a>
          </p>
        )}
      </details>
    </details>
  );
}
