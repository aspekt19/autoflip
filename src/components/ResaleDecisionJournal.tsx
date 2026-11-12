"use client";

import type { ResaleDecisionJournal } from "@/domain/resale-decision-journal";
import { plainDecisionEngineText } from "@/domain/find-buyer-copy";
import {
  buyerSafeResaleJournalText,
  formatResaleJournalInputId,
} from "@/domain/resale-journal-copy";
import { plainRepeatLine } from "@/domain/serv-decision-journal-copy";
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
  const collapsed: Array<(typeof journal.steps)[number] & { repeat: number }> = [];
  for (const step of journal.steps) {
    const prev = collapsed[collapsed.length - 1];
    if (prev && prev.decided === step.decided && prev.why === step.why) prev.repeat += 1;
    else collapsed.push({ ...step, repeat: 1 });
  }

  const body = (
    <ol className="steps-3 story-steps">
        {collapsed.map((step) => {
          const responseId = providerResponseId(step.responseId);
          const showModelLine = step.actor === "SERV" || Boolean(step.model) || Boolean(responseId);
          const speak = (value: string) => plainDecisionEngineText(buyerSafeResaleJournalText(value));
          return (
          <li key={step.id}>
            <strong>
              {step.actor === "SERV" ? "Our review" : "Calculated"}.{" "}
              {speak(plainRepeatLine(step.decided, step.repeat))}
            </strong>
            <span>
              Why: {speak(step.why)}
              {step.changed ? ` What changed: ${speak(step.changed)}` : ""}
            </span>
            {step.inputsUsed.length > 0 ? (
              <span className="hint">
                Based on:{" "}
                {step.inputsUsed.map((id) => plainDecisionEngineText(formatResaleJournalInputId(id))).join(", ")}
              </span>
            ) : null}
            {step.rejected ? (
              // Historical journal lines must not use role=status — that aria-live
              // region re-announces stale http_error text when a later Check finishes
              // with 0 new alerts while the previous journal is still on screen.
              <span className="warn" aria-live="off">
                {speak(step.rejected)}
                {step.why ? ` — ${speak(step.why)}` : ""}
              </span>
            ) : null}
            <details>
              <summary>Technical details</summary>
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
                  Calculated step (no paid review)
                  {step.recordedAt
                    ? ` · ${new Date(step.recordedAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC`
                    : ""}
                </span>
              )}
            </details>
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
            ? ` · ${journal.servCalls} review call${journal.servCalls === 1 ? "" : "s"} this run`
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
          <span className="hint"> · {journal.servCalls} review call{journal.servCalls === 1 ? "" : "s"} this run</span>
        ) : null}
      </summary>
      {body}
    </details>
  );
}
