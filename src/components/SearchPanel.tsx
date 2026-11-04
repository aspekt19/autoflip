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
    <form className="card" onSubmit={onRadar}>
      <div className="modes" role="radiogroup" aria-label="Report mode">
        <label>
          <input type="radio" name="mode" value="personal" checked={mode === "personal"} onChange={() => setMode("personal")} />
          Drive it
        </label>
        <label>
          <input type="radio" name="mode" value="flip" checked={mode === "flip"} onChange={() => setMode("flip")} />
          Flip it
        </label>
      </div>
      <div className="fields">
        <label className="wide">
          <span>Listing URL or VIN</span>
          <input
            name="lookup"
            type="text"
            inputMode="text"
            autoComplete="off"
            placeholder="Paste a dealer listing URL or a 17-character VIN"
            value={lookup}
            onChange={(event) => setLookup(event.target.value)}
          />
        </label>
        <label>
          <span>Make</span>
          <input name="make" type="text" autoComplete="off" value={make} onChange={(event) => setMake(event.target.value)} placeholder="Toyota" />
        </label>
        <label>
          <span>Model</span>
          <input name="model" type="text" autoComplete="off" value={model} onChange={(event) => setModel(event.target.value)} placeholder="Camry" />
        </label>
        <label>
          <span>ZIP</span>
          <input name="zip" type="text" inputMode="numeric" autoComplete="postal-code" value={zip} onChange={(event) => setZip(event.target.value)} placeholder="72758" />
        </label>
        <label>
          <span>Year</span>
          <input name="year" type="text" inputMode="numeric" value={year} onChange={(event) => setYear(event.target.value)} placeholder="2021" />
        </label>
      </div>
      <div className="actions">
        <button className="btn secondary" type="submit">
          Scan Deal Radar · free
        </button>
        <button className="btn" type="button" onClick={onReport} disabled={pending === "report"}>
          {pending === "report" ? "Building report…" : "Full report · 1 credit"}
        </button>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
