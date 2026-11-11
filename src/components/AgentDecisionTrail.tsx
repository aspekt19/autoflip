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
  /**
   * consumer = plain English main view (no model/ids/ISO/raw).
   * proof = full technical trail for the single Show proof expander.
   */
  mode?: "consumer" | "proof";
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
  mode = "consumer",
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
  const savedLabel = savedRunAt
    ? `Saved at ${new Date(savedRunAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC`
    : null;
  const secondCite = (() => {
    if (!second || mode !== "proof") return "";
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

  const secondPlain = (() => {
    if (!second || second.status === "not_run") {
      return `Second AI review not run: ${second?.objection ?? "no challenge record was attached to this run."}`;
    }
    if (second.status === "agreed") return "Second AI review agreed.";
    if (second.status === "disagreed") {
      const action =
        second.action === "needs_inspection"
          ? "needs inspection"
          : second.action
            ? second.action
            : null;
      return `Second AI review disagreed${action ? ` and chose ${action}` : ""}.${
        second.objection ? ` ${second.objection}` : ""
      }`;
    }
    if (second.status === "unavailable") {
      return second.objection ?? "Second AI review unavailable.";
    }
    if (second.status === "skipped_no_budget" || second.status === "skipped_no_key") {
      return second.objection ?? "Second AI review skipped.";
    }
    if (second.status === "ignored_malformed" || second.status === "ignored_no_evidence") {
      return "Second AI review returned nothing usable and was ignored.";
    }
    return null;
  })();

  if (mode === "consumer") {
    const sampleHonesty =
      verdict.no_serv_step &&
      (verdict.unknowns.some((line) => /example not yet recorded/i.test(line)) ||
        /example not yet recorded/i.test(spend?.costNote ?? ""))
        ? "Example not yet recorded. This sample page shows labeled listing economics only — it does not invent an agent revision or second check."
        : null;
    const noAgent =
      verdict.no_serv_step && !sampleHonesty
        ? "This run did not use an AI decision step. The ranking or verdict came from the listed checks only."
        : null;
    const body = (
      <>
        {sampleHonesty ? <p className="lead">{sampleHonesty}</p> : null}
        {noAgent ? <p className="lead">{noAgent}</p> : null}
        {verdict.pick ? (
          <p>
            Our AI picked this car because: <strong>{verdict.pick.label}</strong>.
          </p>
        ) : null}
        {verdict.verdict && !verdict.pick && !sampleHonesty ? (
          <p>
            Our AI’s review: <strong>{verdict.verdict}</strong>
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
        ) : null}
        {secondPlain && !sampleHonesty ? <p>{secondPlain}</p> : null}
        {verdict.vs_cheapest ? (
          <p className="hint">Compared with the cheapest ask: {verdict.vs_cheapest}</p>
        ) : null}
        {verdict.unknowns.length > 0 && !sampleHonesty ? (
          <p className="hint">
            Still open:{" "}
            {verdict.unknowns
              .slice(0, 4)
              .map((line) => line.replace(/\bunknown\b/gi, "not listed"))
              .join(" · ")}
          </p>
        ) : null}
      </>
    );
    if (defaultOpen) {
      return (
        <details className="agent-decision-trail onboarding-note" open>
          <summary>
            <strong>How the agent decided</strong>
          </summary>
          {body}
        </details>
      );
    }
    return <div className="agent-decision-trail onboarding-note">{body}</div>;
  }

  const proofBody = (
    <>
      <p className="hint">
        <strong>How the agent decided</strong>
        {savedLabel ? ` · ${savedLabel}` : ""}
        {verdict.confidence
          ? ` · Confidence ${confidenceLabel(verdict.confidence)}${lowWhy ? ` — ${lowWhy}` : ""}`
          : ""}
      </p>

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
                {step.rawResponse ? (
                  <p className="hint" style={{ whiteSpace: "pre-wrap" }}>
                    {step.rawResponse}
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
              ? ` and chose ${second.action === "needs_inspection" ? "needs inspection" : second.action}`
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
              <p className="hint" style={{ whiteSpace: "pre-wrap" }}>
                {second.rawDump}
              </p>
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
    </>
  );

  void defaultOpen;
  return <div className="agent-decision-trail onboarding-note">{proofBody}</div>;
}
