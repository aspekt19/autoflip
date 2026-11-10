"use client";

import { confidenceLabel, type AgentVerdict } from "@/domain/agent-verdict-schema";
import {
  agentCloseCallPaths,
  agentSecondCheck,
  agentSpend,
  agentTrailSteps,
} from "@/domain/agent-verdict-view";
import { providerResponseId } from "@/domain/serv-response-id";

type Props = {
  verdict: AgentVerdict | null | undefined;
  /** Default open on sample / demos; collapsed on live results. */
  defaultOpen?: boolean;
  /** One-line why confidence is Low/Medium when the trail summary needs it. */
  confidenceWhy?: string | null;
  /**
   * When set, labels this trail as a saved/cached run (not a fresh SERV call).
   * ISO timestamp from check delivery settledAt.
   */
  savedRunAt?: string | null;
};

/**
 * Collapsible "How the agent decided" panel.
 * Structured as decided → why → changed. Never invents steps.
 * Second check is always shown: either a real record or an honest not-run reason.
 */
export function AgentDecisionTrail({
  verdict,
  defaultOpen = false,
  confidenceWhy = null,
  savedRunAt = null,
}: Props) {
  if (!verdict) return null;
  const steps = agentTrailSteps(verdict);
  const closePaths = agentCloseCallPaths(verdict);
  const second = agentSecondCheck(verdict);
  const spend = agentSpend(verdict);
  const lowWhy =
    confidenceWhy?.trim() ||
    (verdict.confidence === "low"
      ? verdict.unknowns.find((line) => /^Low:/i.test(line)) ?? null
      : null);
  // settledAt is when the delivery was stored — label as "saved at", not the SERV step time.
  const savedLabel = savedRunAt
    ? `Saved at ${new Date(savedRunAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC`
    : null;
  const secondCite = (() => {
    if (!second) return "";
    const secondId = providerResponseId(second.responseId);
    if (second.profile || secondId) {
      return ` (${[second.profile, secondId ? `response ${secondId}` : null]
        .filter(Boolean)
        .join(" · ")})`;
    }
    const trailHit = steps.find(
      (step) => /challenge agreed|Second check agreed/i.test(step.decided) && providerResponseId(step.responseId),
    );
    const trailId = trailHit ? providerResponseId(trailHit.responseId) : null;
    return trailId ? ` (response ${trailId})` : "";
  })();

  return (
    <details className="agent-decision-trail onboarding-note" open={defaultOpen}>
      <summary>
        <strong>How the agent decided</strong>
        {savedLabel ? <span className="hint"> · {savedLabel}</span> : null}
        {verdict.confidence ? (
          <span className="hint">
            {" "}
            · Confidence {confidenceLabel(verdict.confidence)}
            {lowWhy ? ` — ${lowWhy}` : ""}
          </span>
        ) : null}
      </summary>

      {verdict.no_serv_step && !closePaths ? (
        <p className="lead">
          {verdict.unknowns.some((line) => /agent step unavailable/i.test(line)) ||
          /agent step unavailable/i.test(spend?.costNote ?? "") ||
          steps.some((step) => /agent step unavailable/i.test(step.decided))
            ? "Agent step unavailable — price rules only."
            : verdict.unknowns.some((line) => /example not yet recorded/i.test(line)) ||
                /example not yet recorded/i.test(spend?.costNote ?? "")
              ? "Example not yet recorded. This sample page shows labeled listing economics only — it does not invent an agent revision or second check."
              : "This run did not use an agent decision step. The ranking or verdict came from code checks only."}
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
          {steps.map((step, index) => {
            const responseId = providerResponseId(step.responseId);
            return (
            <li key={`trail-${index}`}>
              <strong>{step.decided}</strong>
              <span>
                Why: {step.why}
                {step.changed ? ` What changed: ${step.changed}` : ""}
              </span>
              {step.model || responseId || step.recordedAt ? (
                <p className="hint">
                  {step.model ? `Model ${step.model}` : "Model not recorded"}
                  {responseId ? ` · response ${responseId}` : " · no response id"}
                  {step.recordedAt
                    ? ` · ${new Date(step.recordedAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC`
                    : ""}
                </p>
              ) : null}
            </li>
            );
          })}
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

      <section aria-label="Second check">
        <h3>Second check</h3>
        {!second || second.status === "not_run" ? (
          <p>
            Second check not run:{" "}
            {second?.objection ?? "no challenge record was attached to this run."}
          </p>
        ) : null}
        {second?.status === "agreed" ? (
          <p>An independent review agreed with the verdict{secondCite}.</p>
        ) : null}
        {second?.status === "disagreed" ? (
          <p>
            An independent review disagreed
            {second.action
              ? ` (would ${second.action === "needs_inspection" ? "needs inspection" : second.action})`
              : ""}
            {secondCite}.
            {second.objection ? ` ${second.objection}` : ""}
            {second.confidenceBefore &&
            second.confidenceAfter &&
            second.confidenceBefore !== second.confidenceAfter
              ? ` Confidence lowered from ${confidenceLabel(second.confidenceBefore)} to ${confidenceLabel(second.confidenceAfter)}.`
              : ""}
          </p>
        ) : null}
        {second?.status === "unavailable" ? (
          <>
            <p>{second.objection ?? "Second check unavailable: second check did not finish"}</p>
            {second.rawDump ? (
              <details className="onboarding-note">
                <summary>Raw second-check dump</summary>
                <p className="hint" style={{ whiteSpace: "pre-wrap" }}>
                  {second.rawDump}
                </p>
              </details>
            ) : null}
          </>
        ) : null}
        {second?.status === "skipped_no_budget" || second?.status === "skipped_no_key" ? (
          <p>{second.objection ?? "Second check skipped."}</p>
        ) : null}
        {second?.status === "ignored_malformed" || second?.status === "ignored_no_evidence" ? (
          <p>Second check returned nothing usable and was ignored.</p>
        ) : null}
      </section>

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
