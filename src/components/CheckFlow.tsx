"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { SignInGate } from "@/components/SignInGate";
import { PriceBadgeView, PriceRatingHow } from "@/components/PriceBadge";
import { SimilarCarsList } from "@/components/SimilarCarsList";
import {
  formatFreeChecksRemaining,
  freeChecksRemainingFromAccount,
} from "@/domain/free-check-quota";
import { isValidVin } from "@/domain/vin";
import { formatUsd } from "@/domain/format";
import type { PriceBadge } from "@/domain/price-badge";
import type { CheckConfidence, CheckRedFlag, ExtractedListingFields } from "@/domain/listing/types";
import type { SimilarCarView } from "@/domain/purchase-readiness";

type CheckKind = "link" | "vin" | "paste";

type CheckResultView = {
  kind: "listing" | "vin_dossier";
  title: string;
  verdict: string;
  verdictLabel: string;
  confidence: CheckConfidence;
  summary: string;
  badge: PriceBadge | null;
  fairValueUsd: number | null;
  compCount: number;
  compScope: string;
  redFlags: CheckRedFlag[];
  questions: string[];
  otd: { headline: string; lines: string[]; status: string } | null;
  otdNeedsZip: boolean;
  walkAwayUsd: number | null;
  walkAwayLabel: string | null;
  similarCars: SimilarCarView[];
  fields: ExtractedListingFields | null;
  provenance: Array<{ field: string; value: string | number | string[] | null; source: string | null }>;
  vin: string | null;
  recalls: Array<{ campaignNumber: string; component: string; summary: string; parkIt: boolean }>;
  recallsAvailable: boolean;
  complaintCount: number | null;
  fuel: { combMpg: number | null; annualFuelCostUsd: number | null } | null;
  fuelConflict: string | null;
  safetySummary: string | null;
  knownIssues: Array<{ text: string; source: string }>;
  unknown: string[];
  listingsForVin: Array<{
    priceUsd: number | null;
    miles: number | null;
    dealer: string | null;
    vdp: string | null;
    city: string | null;
    state: string | null;
  }>;
  freeChecks?: { remaining: number; limit: number; resetsLabel: string } | null;
};

function sourceLabel(source: string | null): string {
  if (!source) return "unknown";
  if (source === "json_ld") return "JSON-LD";
  if (source === "open_graph") return "Open Graph";
  if (source === "visible_text") return "page text";
  if (source === "pasted_text") return "pasted text";
  if (source === "microdata") return "microdata";
  if (source === "llm") return "model extract";
  if (source === "meta") return "meta tag";
  if (source === "url") return "URL";
  return source;
}

export function CheckFlow() {
  return (
    <SignInGate callbackPath="/check">
      <CheckFlowForm />
    </SignInGate>
  );
}

function CheckFlowForm() {
  const router = useRouter();
  const [kind, setKind] = useState<CheckKind>("link");
  const [url, setUrl] = useState("");
  const [vin, setVin] = useState("");
  const [paste, setPaste] = useState("");
  const [optionalZip, setOptionalZip] = useState("");
  const [showZip, setShowZip] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [result, setResult] = useState<CheckResultView | null>(null);
  const [allowance, setAllowance] = useState<"loading" | "signed-out" | "missing" | string>("loading");

  async function refreshAllowance(from?: {
    freeChecks?: { remaining: number; limit: number; resetsLabel: string } | null;
  }) {
    if (
      from?.freeChecks &&
      typeof from.freeChecks.remaining === "number" &&
      typeof from.freeChecks.limit === "number" &&
      typeof from.freeChecks.resetsLabel === "string"
    ) {
      setAllowance(
        formatFreeChecksRemaining({
          remaining: from.freeChecks.remaining,
          limit: from.freeChecks.limit,
          resetsLabel: from.freeChecks.resetsLabel,
        }),
      );
    }
    try {
      const response = await fetch("/api/account", { cache: "no-store" });
      const body = await response.json();
      setAllowance(freeChecksRemainingFromAccount(body));
    } catch {
      setAllowance((prev) => (prev === "loading" ? "missing" : prev));
    }
  }

  useEffect(() => {
    void refreshAllowance();
  }, []);

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("af-check");
      if (!raw) return;
      const saved = JSON.parse(raw) as {
        checkKind?: CheckKind;
        lookup?: string;
        paste?: string;
        optionalZip?: string;
      };
      if (saved.checkKind === "link" || saved.checkKind === "vin" || saved.checkKind === "paste") {
        setKind(saved.checkKind);
      }
      if (saved.checkKind === "vin" && typeof saved.lookup === "string") setVin(saved.lookup);
      if (saved.checkKind === "link" && typeof saved.lookup === "string") setUrl(saved.lookup);
      if (typeof saved.paste === "string") setPaste(saved.paste);
      if (typeof saved.optionalZip === "string") setOptionalZip(saved.optionalZip);
    } catch {
      /* ignore */
    }
  }, []);

  function stash() {
    try {
      sessionStorage.setItem(
        "af-check",
        JSON.stringify({
          checkKind: kind,
          lookup: kind === "vin" ? vin : url,
          paste,
          optionalZip,
        }),
      );
    } catch {
      /* ignore */
    }
  }

  async function submit() {
    setError(null);
    setBlocked(false);
    setResult(null);

    if (kind === "link" && !url.trim()) {
      setError("Paste any listing link.");
      return;
    }
    if (kind === "vin") {
      if (!vin.trim()) {
        setError("Enter a 17-character VIN.");
        return;
      }
      if (!isValidVin(vin.trim())) {
        setError("Enter a valid 17-character VIN.");
        return;
      }
    }
    if (kind === "paste" && !paste.trim()) {
      setError("Paste the listing text from the page.");
      return;
    }

    setPending(true);
    void refreshAllowance();
    try {
      const payload =
        kind === "link"
          ? { kind: "link", url: url.trim(), optionalZip: optionalZip.trim() || undefined }
          : kind === "vin"
            ? { kind: "vin", vin: vin.trim().toUpperCase(), optionalZip: optionalZip.trim() || undefined }
            : {
                kind: "paste",
                text: paste,
                url: url.trim() || undefined,
                optionalZip: optionalZip.trim() || undefined,
              };

      const response = await fetch("/api/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await response.json()) as CheckResultView & {
        error?: string;
        message?: string;
        blocked?: boolean;
        alternatives?: string[];
        ok?: boolean;
        freeChecks?: { remaining: number; limit: number; resetsLabel: string } | null;
      };

      if (response.status === 401 || response.status === 403) {
        await refreshAllowance(body);
        if (body.error === "credits_required") {
          stash();
          router.push("/credits?need=1&return=%2Fcheck");
          return;
        }
        if (
          body.error === "auth_required" ||
          body.error === "auth_unconfigured" ||
          body.error === "email_unverified"
        ) {
          stash();
          router.push(`/login?callbackUrl=${encodeURIComponent("/check")}`);
          return;
        }
      }

      if (!response.ok) {
        setBlocked(body.blocked === true);
        setError(body.message ?? "The check did not finish.");
        if (body.blocked) setKind("paste");
        await refreshAllowance(body);
        return;
      }

      setResult(body);
      await refreshAllowance(body);
      try {
        sessionStorage.removeItem("af-check");
      } catch {
        /* ignore */
      }
    } catch {
      setError("The check did not finish.");
      await refreshAllowance();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="panel check-flow">
      <div className="pills" role="radiogroup" aria-label="How to check">
        <label className="pill">
          <input type="radio" name="check-kind" checked={kind === "link"} onChange={() => setKind("link")} />
          By listing link
        </label>
        <label className="pill">
          <input type="radio" name="check-kind" checked={kind === "vin"} onChange={() => setKind("vin")} />
          By VIN
        </label>
        <label className="pill">
          <input type="radio" name="check-kind" checked={kind === "paste"} onChange={() => setKind("paste")} />
          Paste listing text
        </label>
      </div>

      {kind === "link" ? (
        <>
          <p className="hint">
            Paste any listing URL. Lemonless fetches the public page and reads what it can — price, vehicle facts, VIN,
            and seller claims. No login or captcha bypass.
          </p>
          <div className="field">
            <label htmlFor="listing-url">Listing link</label>
            <input
              id="listing-url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://"
              autoComplete="off"
            />
          </div>
        </>
      ) : null}

      {kind === "vin" ? (
        <>
          <p className="hint">
            Enter only the VIN. Lemonless builds a free-source dossier: VIN decode, recalls, complaints, crash ratings,
            fuel economy, known model-year notes, and any current listings for that VIN.
          </p>
          <div className="field">
            <label htmlFor="check-vin">17-character VIN</label>
            <input
              id="check-vin"
              value={vin}
              onChange={(event) => setVin(event.target.value)}
              placeholder="17-character VIN"
              autoComplete="off"
            />
          </div>
        </>
      ) : null}

      {kind === "paste" ? (
        <>
          <p className="hint">
            If the site blocked fetching, paste the listing text here. Optional: keep the original URL for reference.
          </p>
          <div className="field">
            <label htmlFor="listing-paste">Listing text</label>
            <textarea
              id="listing-paste"
              value={paste}
              onChange={(event) => setPaste(event.target.value)}
              rows={8}
              placeholder="Paste the listing title, price, mileage, VIN, and description…"
            />
          </div>
          <div className="field">
            <label htmlFor="listing-url-optional">Listing link (optional)</label>
            <input
              id="listing-url-optional"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://"
            />
          </div>
        </>
      ) : null}

      {kind !== "vin" ? (
        showZip || result?.otdNeedsZip ? (
          <div className="field">
            <label htmlFor="otd-zip">ZIP for out-the-door tax estimate (optional)</label>
            <input
              id="otd-zip"
              value={optionalZip}
              onChange={(event) => setOptionalZip(event.target.value)}
              inputMode="numeric"
              placeholder="e.g. 33101"
            />
          </div>
        ) : (
          <p className="hint">
            <button type="button" className="quiet" onClick={() => setShowZip(true)}>
              Add a ZIP for the tax estimate
            </button>{" "}
            — only needed when the listing has no location.
          </p>
        )
      ) : null}

      <div className="btn-row">
        <button className="ghost" type="button" onClick={() => router.push("/")}>
          Back
        </button>
        <button
          className="action"
          type="button"
          disabled={pending || (kind === "vin" && Boolean(vin.trim()) && !isValidVin(vin.trim()))}
          onClick={() => void submit()}
        >
          {pending ? "Checking…" : kind === "vin" ? "Check this VIN" : "Check this car"}
        </button>
      </div>

      {allowance === "loading" ? null : allowance === "signed-out" ? null : allowance === "missing" ? (
        <p className="hint">Free checks could not be loaded.</p>
      ) : (
        <p className="hint">{allowance}</p>
      )}

      {error ? (
        <p className="warn" role="alert">
          {error}
          {blocked ? (
            <>
              {" "}
              Use <strong>Paste listing text</strong> or <strong>By VIN</strong>.
            </>
          ) : null}
        </p>
      ) : null}

      {result ? <CheckResultCard result={result} /> : null}
    </div>
  );
}

function CheckResultCard({ result }: { result: CheckResultView }) {
  const priced = result.fields?.priceUsd.value;
  const stopFlags = result.redFlags.filter((flag) => flag.level === "stop");
  const sold = result.redFlags.some((flag) => flag.id === "sold");
  const similarCars = result.similarCars ?? [];
  return (
    <article className="warn-box check-result" aria-live="polite">
      <p className="kicker">{result.kind === "vin_dossier" ? "VIN dossier" : "Listing check"}</p>
      <h2>{result.title}</h2>
      <p className="lead">
        <strong>{result.verdictLabel}</strong>
        {" · "}
        Confidence: {result.confidence}
      </p>
      <p>{result.summary}</p>

      {sold ? (
        <p className="warn" role="status">
          This listing is marked SOLD. Do not treat seller questions or price notes as a green light to buy until the
          seller confirms the car is still available.
        </p>
      ) : null}

      {result.badge ? (
        <>
          <PriceBadgeView badge={result.badge} />
          <p className="hint">{result.compScope}</p>
          <PriceRatingHow />
        </>
      ) : null}

      {result.kind === "listing" && (result.walkAwayLabel || similarCars.length > 0) ? (
        <section>
          <h3>Walk-away and comps</h3>
          {result.walkAwayLabel ? <p>{result.walkAwayLabel}</p> : null}
          {result.walkAwayUsd != null ? (
            <p className="lead">
              Walk-away: <strong>{formatUsd(result.walkAwayUsd)}</strong>
            </p>
          ) : null}
          {similarCars.length > 0 ? <SimilarCarsList cars={similarCars} open /> : null}
        </section>
      ) : null}

      {result.redFlags.length > 0 ? (
        <section>
          <h3>Red flags</h3>
          <ul className="refuse">
            {result.redFlags.map((flag) => (
              <li key={flag.id}>
                <strong>{flag.level === "stop" ? "Stop" : flag.level === "caution" ? "Caution" : "Note"}:</strong>{" "}
                {flag.text}
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="hint">No stop-level red flags from the listing text. Missing history is still unknown.</p>
      )}

      {stopFlags.length === 0 && result.redFlags.length > 0 ? (
        <p className="hint">No stop-level red flags. The notes above are cautions, and missing history is still unknown.</p>
      ) : null}

      {result.otd ? (
        <section>
          <h3>Out-the-door estimate</h3>
          <p>{result.otd.headline}</p>
          <ul className="refuse">
            {result.otd.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      ) : result.otdNeedsZip && result.kind === "listing" ? (
        <p className="hint">Add a ZIP above to estimate state sales tax for the out-the-door floor.</p>
      ) : priced == null && result.kind === "listing" ? (
        <p className="hint">No asking price was found, so an out-the-door estimate is not available.</p>
      ) : null}

      <section>
        <h3>Government checks</h3>
        <ul className="refuse">
          <li>
            Recalls:{" "}
            {!result.recallsAvailable
              ? "unavailable"
              : result.recalls.length === 0
                ? "none listed for this model year"
                : `${result.recalls.length} model-year campaign${result.recalls.length === 1 ? "" : "s"}`}
          </li>
          <li>
            Complaints:{" "}
            {result.complaintCount == null ? "unavailable" : `${result.complaintCount} for this model year`}
          </li>
          <li>{result.safetySummary ?? "Crash ratings: not checked"}</li>
          <li>
            Fuel:{" "}
            {result.fuel?.combMpg != null
              ? `about ${result.fuel.combMpg} mpg combined${result.fuel.annualFuelCostUsd != null ? ` · ~${formatUsd(result.fuel.annualFuelCostUsd)}/yr` : ""}`
              : "unavailable"}
          </li>
          {result.fuelConflict ? <li>{result.fuelConflict}</li> : null}
          {result.vin ? <li>VIN: {result.vin}</li> : <li>VIN: not found on the listing</li>}
        </ul>
      </section>

      {result.knownIssues.length > 0 ? (
        <section>
          <h3>What this means</h3>
          <ul className="refuse">
            {result.knownIssues.map((issue) => (
              <li key={issue.text}>{issue.text}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {result.listingsForVin.length > 0 ? (
        <section>
          <h3>Listings for this VIN</h3>
          <ul className="refuse">
            {result.listingsForVin.map((row, index) => (
              <li key={`${row.vdp ?? "row"}-${index}`}>
                {row.priceUsd != null ? formatUsd(row.priceUsd) : "Price unknown"}
                {row.miles != null ? ` · ${row.miles.toLocaleString("en-US")} miles` : ""}
                {row.dealer ? ` · ${row.dealer}` : ""}
                {row.city || row.state ? ` · ${[row.city, row.state].filter(Boolean).join(", ")}` : ""}
                {row.vdp ? (
                  <>
                    {" · "}
                    <a href={row.vdp} target="_blank" rel="noreferrer">
                      Listing
                    </a>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {result.questions.length > 0 ? (
        <section>
          <h3>Ask the seller</h3>
          {sold ? (
            <p className="hint">
              These questions only matter if the seller confirms the car is still available — the listing is marked SOLD.
            </p>
          ) : null}
          <ul className="refuse">
            {result.questions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {result.provenance.length > 0 ? (
        <section>
          <h3>What we extracted</h3>
          <ul className="refuse">
            {result.provenance
              .filter((row) => row.value != null && row.value !== "")
              .map((row) => (
                <li key={row.field}>
                  <strong>{row.field}</strong>:{" "}
                  {Array.isArray(row.value) ? row.value.join(", ") : String(row.value)}{" "}
                  <span className="hint">({sourceLabel(row.source)})</span>
                </li>
              ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h3>Still unknown</h3>
        <ul className="refuse">
          {result.unknown.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <p className="hint">
          A report is a screening tool, not an inspection or a complete history record.{" "}
          <Link href="/report/sample">See a sample full report</Link>.
        </p>
      </section>
    </article>
  );
}
