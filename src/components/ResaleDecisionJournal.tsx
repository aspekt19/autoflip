"use client";

import type { ResaleDecisionJournal } from "@/domain/resale-decision-journal";

/** User-facing SERV/code decision journal for Resale and Radar. */
export function ResaleDecisionJournalView({
  journal,
  defaultOpen = true,
}: {
  journal: ResaleDecisionJournal | null | undefined;
  defaultOpen?: boolean;
}) {
  if (!journal || journal.steps.length === 0) return null;

  return (
    <details className="agent-decision-trail onboarding-note" open={defaultOpen}>
      <summary>
        <strong>Decision journal</strong>
        <span className="hint">
          {" "}
          · SERV {journal.servCalls}/{journal.servCallCap} HTTP calls
        </span>
      </summary>
      <ol className="steps-3 story-steps">
        {journal.steps.map((step) => (
          <li key={step.id}>
            <strong>
              [{step.actor}] {step.decided}
            </strong>
            <span>
              Why: {step.why}
              {step.changed ? ` What changed: ${step.changed}` : ""}
            </span>
            {step.inputsUsed.length > 0 ? (
              <span className="hint">Inputs: {step.inputsUsed.join(", ")}</span>
            ) : null}
            {step.rejected ? (
              <span className="warn" role="status">
                {step.rejected}
                {step.why ? ` — ${step.why}` : ""}
              </span>
            ) : null}
            <span className="hint">
              {step.model ? `Model ${step.model}` : "Model not recorded"}
              {step.responseId ? ` · response ${step.responseId}` : " · no response id"}
              {step.recordedAt
                ? ` · ${new Date(step.recordedAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC`
                : ""}
            </span>
          </li>
        ))}
      </ol>
    </details>
  );
}
