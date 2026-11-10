"use client";

import type { ResaleDecisionJournal } from "@/domain/resale-decision-journal";
import { providerResponseId } from "@/domain/serv-response-id";

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
        {journal.servCalls > 0 ? (
          <span className="hint"> · {journal.servCalls} paid model call{journal.servCalls === 1 ? "" : "s"} this run</span>
        ) : null}
      </summary>
      <ol className="steps-3 story-steps">
        {journal.steps.map((step) => {
          const responseId = providerResponseId(step.responseId);
          return (
          <li key={step.id}>
            <strong>
              [{step.actor}] {step.decided}
            </strong>
            <span>
              Why: {step.why}
              {step.changed ? ` What changed: ${step.changed}` : ""}
            </span>
            {step.inputsUsed.length > 0 ? (
              <span className="hint">
                Inputs:{" "}
                {step.inputsUsed
                  .map((id) =>
                    id.startsWith("pnl:")
                      ? `P&L for ${id.slice(4)}`
                      : id.startsWith("vin:")
                        ? `VIN ${id.slice(4)}`
                        : id.startsWith("check:")
                          ? id.slice(6).replace(/_/g, " ")
                          : id,
                  )
                  .join(", ")}
              </span>
            ) : null}
            {step.rejected ? (
              // Historical journal lines must not use role=status — that aria-live
              // region re-announces stale http_error text when a later Check finishes
              // with 0 new alerts while the previous journal is still on screen.
              <span className="warn" aria-live="off">
                {step.rejected}
                {step.why ? ` — ${step.why}` : ""}
              </span>
            ) : null}
            <span className="hint">
              {step.model ? `Model ${step.model}` : "Model not recorded"}
              {responseId ? ` · response ${responseId}` : " · no response id"}
              {step.recordedAt
                ? ` · ${new Date(step.recordedAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC`
                : ""}
            </span>
          </li>
          );
        })}
      </ol>
    </details>
  );
}
