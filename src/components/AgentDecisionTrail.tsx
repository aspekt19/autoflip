"use client";

import { confidenceLabel, type AgentVerdict } from "@/domain/agent-verdict-schema";
import {
  agentCloseCallPaths,
  agentSecondCheck,
  agentSpend,
  agentTrailSteps,
} from "@/domain/agent-verdict-view";

type Props = {
  verdict: AgentVerdict | null | undefined;
  /** Default open on sample / demos; collapsed on live results. */
  defaultOpen?: boolean;
};

/**
 * Collapsible "How the agent decided" panel.
 * Structured as decided → why → changed. Never invents steps.
 * Consumer copy avoids banned internal feature names.
 */
export function AgentDecisionTrail({ verdict, defaultOpen = false }: Props) {
  if (!verdict) return null;
  const steps = agentTrailSteps(verdict);
  const closePaths = agentCloseCallPaths(verdict);
  const second = agentSecondCheck(verdict);
  const spend = agentSpend(verdict);

  return (
    <details className="agent-decision-trail onboarding-note" open={defaultOpen}>
      <summary>
        <strong>How the agent decided</strong>
        {verdict.confidence ? (
          <span className="hint"> · Confidence {confidenceLabel(verdict.confidence)}</span>
        ) : null}
      </summary>

      {verdict.no_serv_step && !closePaths ? (
        <p className="lead">
          This run did not use an agent decision step. The ranking or verdict came from code checks only.
        </p>
      ) : null}
      {verdict.no_serv_step && closePaths ? (
        <p className="hint">
          No paid agent call recorded for this run. Close-call paths below were reconciled by code from the same
          evidence.
        </p>
      ) : null}

      {verdict.pick ? (
        <p>
          <strong>Pick:</strong> {verdict.pick.label}
        </p>
      ) : null}
      {verdict.verdict ? (
        <p>
          <strong>Verdict:</strong> {verdict.verdict}
        </p>
      ) : null}

      {steps.length > 0 ? (
        <ol className="steps-3 story-steps">
          {steps.map((step, index) => (
            <li key={`trail-${index}`}>
              <strong>{step.decided}</strong>
              <span>
                Why: {step.why}
                {step.changed ? ` What changed: ${step.changed}` : ""}
              </span>
            </li>
          ))}
        </ol>
      ) : !verdict.no_serv_step ? (
        <p className="hint">No structured decision steps were recorded for this run.</p>
      ) : null}

      {closePaths ? (
        <section aria-label="Close-call reasoning paths">
          <h3>Close-call paths</h3>
          <ul className="refuse">
            {closePaths.paths.map((path) => (
              <li key={path.id}>
                <strong>{path.label}:</strong> {path.pickLabel ?? "none"} — {path.summary}
              </li>
            ))}
          </ul>
          <p>
            <strong>Reconciliation:</strong> {closePaths.reconciliation}
          </p>
        </section>
      ) : null}

      {second && second.status !== "not_run" ? (
        <section aria-label="Second check">
          <h3>Second check</h3>
          {second.status === "agreed" ? <p>An independent review agreed with the verdict.</p> : null}
          {second.status === "disagreed" ? (
            <p>
              An independent review disagreed
              {second.action
                ? ` (would ${second.action === "needs_inspection" ? "needs inspection" : second.action})`
                : ""}
              .
              {second.objection ? ` ${second.objection}` : ""}
              {second.confidenceBefore &&
              second.confidenceAfter &&
              second.confidenceBefore !== second.confidenceAfter
                ? ` Confidence lowered from ${confidenceLabel(second.confidenceBefore)} to ${confidenceLabel(second.confidenceAfter)}.`
                : ""}
            </p>
          ) : null}
          {second.status === "unavailable" ? (
            <p>{second.objection ?? "Second check did not finish. The first verdict stands."}</p>
          ) : null}
          {second.status === "skipped_no_budget" || second.status === "skipped_no_key" ? (
            <p>{second.objection ?? "Second check skipped."}</p>
          ) : null}
          {second.status === "ignored_malformed" || second.status === "ignored_no_evidence" ? (
            <p>Second check returned nothing usable and was ignored.</p>
          ) : null}
        </section>
      ) : null}

      {verdict.vs_cheapest ? (
        <p className="hint">
          <strong>Versus cheapest ask:</strong> {verdict.vs_cheapest}
        </p>
      ) : null}

      {spend ? (
        <p className="hint">
          Agent calls recorded: {spend.calls}
          {spend.costNote ? ` · ${spend.costNote}` : ""}
        </p>
      ) : null}

      {verdict.unknowns.length > 0 ? (
        <p className="hint">Still unknown: {verdict.unknowns.slice(0, 4).join(" · ")}</p>
      ) : null}
    </details>
  );
}
