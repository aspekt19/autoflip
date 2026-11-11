"use client";

import type { ResaleDecisionJournal } from "@/domain/resale-decision-journal";
import {
  buyerSafeResaleJournalText,
  formatResaleJournalInputId,
} from "@/domain/resale-journal-copy";
import { providerResponseId } from "@/domain/serv-response-id";

/** User-facing SERV/code decision journal for Resale and Radar. */
export function ResaleDecisionJournalView({
  journal,
  defaultOpen = true,
  embedded = false,
}: {
  journal: ResaleDecisionJournal | null | undefined;
  defaultOpen?: boolean;
  embedded?: boolean;
}) {
  if (!journal || journal.steps.length === 0) return null;

  const body = (
    <ol className="steps-3 story-steps">
        {journal.steps.map((step) => {
          const responseId = providerResponseId(step.responseId);
          const showModelLine = step.actor === "SERV" || Boolean(step.model) || Boolean(responseId);
          return (
          <li key={step.id}>
            <strong>
              [{step.actor}] {buyerSafeResaleJournalText(step.decided)}
            </strong>
            <span>
              Why: {buyerSafeResaleJournalText(step.why)}
              {step.changed ? ` What changed: ${buyerSafeResaleJournalText(step.changed)}` : ""}
            </span>
            {step.inputsUsed.length > 0 ? (
              <span className="hint">
                Inputs:{" "}
                {step.inputsUsed.map((id) => formatResaleJournalInputId(id)).join(", ")}
              </span>
            ) : null}
            {step.rejected ? (
              // Historical journal lines must not use role=status — that aria-live
              // region re-announces stale http_error text when a later Check finishes
              // with 0 new alerts while the previous journal is still on screen.
              <span className="warn" aria-live="off">
                {buyerSafeResaleJournalText(step.rejected)}
                {step.why ? ` — ${buyerSafeResaleJournalText(step.why)}` : ""}
              </span>
            ) : null}
            {showModelLine ? (
              <span className="hint">
                {step.model ? `Model ${step.model}` : "Model not recorded"}
                {responseId ? ` · response ${responseId}` : " · no response id"}
                {step.recordedAt
                  ? ` · ${new Date(step.recordedAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC`
                  : ""}
              </span>
            ) : (
              <span className="hint">
                Code step (no paid model call)
                {step.recordedAt
                  ? ` · ${new Date(step.recordedAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC`
                  : ""}
              </span>
            )}
          </li>
          );
        })}
      </ol>
  );

  if (embedded) {
    return (
      <div className="agent-decision-trail onboarding-note">
        <p className="hint">
          <strong>Decision journal</strong>
          {journal.servCalls > 0
            ? ` · ${journal.servCalls} paid model call${journal.servCalls === 1 ? "" : "s"} this run`
            : ""}
        </p>
        {body}
      </div>
    );
  }

  return (
    <details className="agent-decision-trail onboarding-note" open={defaultOpen}>
      <summary>
        <strong>Decision journal</strong>
        {journal.servCalls > 0 ? (
          <span className="hint"> · {journal.servCalls} paid model call{journal.servCalls === 1 ? "" : "s"} this run</span>
        ) : null}
      </summary>
      {body}
    </details>
  );
}
