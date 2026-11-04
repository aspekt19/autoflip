"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import type { Mode } from "@/domain/types";

type Props = {
  initial?: {
    lookup?: string;
    make?: string;
    model?: string;
    zip?: string;
    year?: string;
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
  const [year, setYear] = useState(initial?.year ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<"radar" | "report" | null>(null);

  async function onRadar(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (!make.trim() || !model.trim()) {
      setError("Deal Radar needs a make and a model. A single VIN uses the full report.");
      return;
    }
    const params = new URLSearchParams({ make: make.trim(), model: model.trim(), mode });
    if (zip.trim()) params.set("zip", zip.trim());
    if (year.trim()) params.set("year", year.trim());
    router.push(`/radar?${params.toString()}`);
  }

  async function onReport() {
    setError(null);
    if (!lookup.trim()) {
      setError("Paste a listing URL or a VIN for a full report. Deal Radar is the free scan.");
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
          year: year.trim() ? Number(year) : undefined,
        }),
      });
      const body = (await response.json()) as { id?: string; message?: string; error?: string };
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
      <div className="pair">
        <div className="field">
          <label htmlFor="make">Make</label>
          <input id="make" name="make" type="text" autoComplete="off" value={make} onChange={(event) => setMake(event.target.value)} placeholder="Toyota" />
        </div>
        <div className="field">
          <label htmlFor="model">Model</label>
          <input id="model" name="model" type="text" autoComplete="off" value={model} onChange={(event) => setModel(event.target.value)} placeholder="Camry" />
        </div>
      </div>
      <div className="pair">
        <div className="field">
          <label htmlFor="zip">ZIP</label>
          <input id="zip" name="zip" type="text" inputMode="numeric" autoComplete="postal-code" value={zip} onChange={(event) => setZip(event.target.value)} placeholder="72758" />
        </div>
        <div className="field">
          <label htmlFor="year">Year</label>
          <input id="year" name="year" type="text" inputMode="numeric" value={year} onChange={(event) => setYear(event.target.value)} placeholder="2021" />
        </div>
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
