"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import type { Mode } from "@/domain/types";
import { MakeModelFields } from "./MakeModelFields";

type Props = {
  initial?: {
    lookup?: string;
    make?: string;
    model?: string;
    zip?: string;
    year?: string;
    yearMin?: string;
    yearMax?: string;
    mode?: Mode;
  };
};

export function SearchPanel({ initial }: Props) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(initial?.mode ?? "personal");
  const [lookup, setLookup] = useState(initial?.lookup ?? "");
  const [make, setMake] = useState(initial?.make ?? "");
  const [model, setModel] = useState(initial?.model ?? "");
  const [zip, setZip] = useState(initial?.zip ?? "");
  const [yearMin, setYearMin] = useState(initial?.yearMin ?? initial?.year ?? "");
  const [yearMax, setYearMax] = useState(initial?.yearMax ?? initial?.year ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"radar" | "report" | null>(null);

  async function onRadar(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!make.trim()) {
      setError("Choose a make. A single VIN still uses the full report.");
      return;
    }
    const [from, to] = orderedYears(yearMin, yearMax);
    const params = new URLSearchParams({ make: make.trim(), mode });
    if (model.trim()) params.set("model", model.trim());
    if (zip.trim()) params.set("zip", zip.trim());
    if (from) params.set("yearMin", from);
    if (to) params.set("yearMax", to);
    router.push(`/radar?${params.toString()}`);
  }

  async function onReport() {
    setError(null);
    if (!lookup.trim()) {
      setError("Paste a listing URL or a VIN for a full report. Deal Radar watches require a paid Radar or Radar Pro plan.");
      return;
    }
    setPending("report");
    try {
      const response = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          url: lookup.trim(),
          vin: lookup.trim(),
          make: make.trim() || undefined,
          model: model.trim() || undefined,
          zip: zip.trim() || undefined,
          yearMin: orderedYears(yearMin, yearMax)[0] ? Number(orderedYears(yearMin, yearMax)[0]) : undefined,
          yearMax: orderedYears(yearMin, yearMax)[1] ? Number(orderedYears(yearMin, yearMax)[1]) : undefined,
        }),
      });
      const body = (await response.json()) as { id?: string; message?: string; error?: string };
      if (response.status === 401 || (response.status === 403 && (body.error === "auth_required" || body.error === "auth_unconfigured" || body.error === "email_unverified" || body.error === "email_required"))) {
        router.push("/login?callbackUrl=/");
        return;
      }
      if (response.status === 403 && body.error === "credits_required") {
        router.push("/credits?need=1");
        return;
      }
      if (!response.ok || !body.id) {
        setError(body.message || "The report could not be built.");
        return;
      }
      router.push(`/report/${body.id}`);
    } catch {
      setError("The report request did not finish.");
    } finally {
      setPending(null);
    }
  }

  return (
    <form className="panel" onSubmit={onRadar}>
      <fieldset className="field">
        <legend>What do you want to know?</legend>
        <div className="pills" role="radiogroup" aria-label="Report mode">
          <label className="pill">
            <input type="radio" name="mode" value="personal" checked={mode === "personal"} onChange={() => setMode("personal")} />
            Drive it
          </label>
          <label className="pill">
            <input type="radio" name="mode" value="flip" checked={mode === "flip"} onChange={() => setMode("flip")} />
            Flip it
          </label>
        </div>
      </fieldset>
      <div className="field">
        <label htmlFor="lookup">Listing URL or VIN</label>
        <input
          id="lookup"
          name="lookup"
          type="text"
          inputMode="text"
          autoComplete="off"
          placeholder="Paste a dealer listing URL or a 17-character VIN"
          value={lookup}
          onChange={(event) => setLookup(event.target.value)}
        />
      </div>
      <MakeModelFields
        make={make}
        model={model}
        yearMin={yearMin}
        yearMax={yearMax}
        onMake={setMake}
        onModel={setModel}
        onYearMin={setYearMin}
        onYearMax={setYearMax}
      />
      <div className="field">
        <label htmlFor="zip">ZIP</label>
        <input id="zip" name="zip" type="text" inputMode="numeric" autoComplete="postal-code" value={zip} onChange={(event) => setZip(event.target.value)} placeholder="72758" />
      </div>
      <div className="hero-actions">
        <button className="quiet" type="submit">
          Scan Deal Radar
        </button>
        <button className="action" type="button" onClick={onReport} disabled={pending === "report"}>
          {pending === "report" ? "Building report…" : "Full report · 1 credit"}
        </button>
      </div>
      {error ? (
        <p className="warn" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function orderedYears(yearMin: string, yearMax: string): [string, string] {
  if (yearMin && yearMax && Number(yearMin) > Number(yearMax)) return [yearMax, yearMin];
  return [yearMin, yearMax];
}
