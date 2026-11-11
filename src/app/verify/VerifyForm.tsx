"use client";

import { useEffect, useState } from "react";

type VerifyResponse = {
  ok: boolean;
  reportId?: string;
  reportHash?: string;
  tipHash?: string;
  linkCount?: number;
  issues?: string[];
  reportHashMatch?: boolean | null;
  sealedAt?: string;
  steps?: Array<{
    index: number;
    hash: string;
    prevHash: string;
    step: string;
    by: string;
    status: string;
    runId: string | null;
    modelId: string | null;
  }>;
  error?: string;
  message?: string;
};

export function VerifyForm({ initialId }: { initialId: string }) {
  const [id, setId] = useState(initialId);
  const [result, setResult] = useState<VerifyResponse | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!initialId) return;
    let cancelled = false;
    (async () => {
      setPending(true);
      try {
        const res = await fetch(`/api/verify?id=${encodeURIComponent(initialId)}`, { cache: "no-store" });
        const body = (await res.json()) as VerifyResponse;
        if (!cancelled) setResult(body);
      } catch {
        if (!cancelled) setResult({ ok: false, message: "Verify request failed." });
      } finally {
        if (!cancelled) setPending(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [initialId]);

  async function runVerify(reportId: string) {
    const trimmed = reportId.trim();
    if (!trimmed) {
      setResult({ ok: false, message: "Enter a report or run id." });
      return;
    }
    setPending(true);
    setResult(null);
    try {
      const res = await fetch(`/api/verify?id=${encodeURIComponent(trimmed)}`, { cache: "no-store" });
      const body = (await res.json()) as VerifyResponse;
      setResult(body);
    } catch {
      setResult({ ok: false, message: "Verify request failed." });
    } finally {
      setPending(false);
    }
  }

  return (
    <section>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          void runVerify(id);
        }}
      >
        <label>
          Report or run id
          <input
            value={id}
            onChange={(event) => setId(event.target.value)}
            placeholder="report id"
            autoComplete="off"
          />
        </label>
        <button type="submit" className="btn" disabled={pending}>
          {pending ? "Checking…" : "Verify"}
        </button>
      </form>

      {result ? (
        <div className="onboarding-note">
          {result.ok ? (
            <p className="lead">Trail checks out.</p>
          ) : (
            <p className="lead warn">{result.message ?? "Trail did not verify."}</p>
          )}
          {result.reportId ? (
            <ul className="refuse">
              <li>
                Id: <span className="mono">{result.reportId}</span>
              </li>
              {result.reportHash ? (
                <li>
                  Report hash: <span className="mono">{result.reportHash}</span>
                </li>
              ) : null}
              {result.tipHash ? (
                <li>
                  Tip hash: <span className="mono">{result.tipHash}</span>
                </li>
              ) : null}
              {typeof result.linkCount === "number" ? <li>Links: {result.linkCount}</li> : null}
              {result.sealedAt ? <li>Sealed at {result.sealedAt}</li> : null}
              {result.reportHashMatch === false ? (
                <li className="warn">Stored report content no longer matches the sealed hash.</li>
              ) : null}
              {result.reportHashMatch === true ? <li>Stored report content matches the sealed hash.</li> : null}
            </ul>
          ) : null}
          {result.issues && result.issues.length > 0 ? (
            <ul className="refuse">
              {result.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          ) : null}
          {result.steps && result.steps.length > 0 ? (
            <ol className="steps-3 story-steps">
              {result.steps.map((step) => (
                <li key={`${step.index}-${step.hash}`}>
                  <strong>
                    [{step.by}] {step.step} — {step.status}
                  </strong>
                  <span className="hint">
                    hash {step.hash.slice(0, 12)}… · prev {step.prevHash.slice(0, 12)}…
                    {step.runId ? ` · ${step.runId}` : ""}
                    {step.modelId ? ` · ${step.modelId}` : ""}
                  </span>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
