"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import type { Mode } from "@/domain/types";
import { ZipRadiusFields } from "./ZipRadiusFields";

export function HomeSearch({ onModeChange }: { onModeChange?: (mode: Mode) => void }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [mode, setMode] = useState<Mode>("personal");
  const [zip, setZip] = useState("");
  const [distanceMiles, setDistanceMiles] = useState<number | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);

  function choose(next: Mode) {
    setMode(next);
    onModeChange?.(next);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = note.trim();
    if (text.length < 8) return;
    setGeoError(null);
    const trimmedZip = zip.trim();
    if (distanceMiles != null && !trimmedZip) {
      setGeoError("Add a ZIP for a seller-distance radius, or choose Nationwide.");
      return;
    }
    if (trimmedZip && !/^\d{5}$/.test(trimmedZip)) {
      setGeoError("ZIP needs to be 5 digits, or left blank for Nationwide.");
      return;
    }
    const params = new URLSearchParams({ note: text, mode });
    if (trimmedZip) params.set("zip", trimmedZip);
    if (distanceMiles == null) {
      params.set("distanceMiles", "nationwide");
    } else {
      params.set("distanceMiles", String(distanceMiles));
    }
    router.push(`/find?${params.toString()}`);
  }

  return (
    <form className="hero-chat" onSubmit={submit}>
      <fieldset className="pills" aria-label="Who is this for">
        <label className="pill">
          <input type="radio" name="home-mode" checked={mode === "personal"} onChange={() => choose("personal")} /> For me
        </label>
        <label className="pill">
          <input type="radio" name="home-mode" checked={mode === "flip"} onChange={() => choose("flip")} /> For resale
        </label>
      </fieldset>
      <label className="sr-only" htmlFor="home-note">
        Describe the car you need
      </label>
      <textarea
        id="home-note"
        rows={3}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="Describe the car you need. A reliable SUV under $20,000 near Dallas…"
      />
      <ZipRadiusFields
        idPrefix="home"
        zip={zip}
        distanceMiles={distanceMiles}
        onZipChange={setZip}
        onDistanceChange={setDistanceMiles}
      />
      {geoError ? (
        <p className="warn" role="alert">
          {geoError}
        </p>
      ) : null}
      <div className="btn-row">
        <button className="action" type="submit" disabled={note.trim().length < 8}>
          Find cars
        </button>
        <a className="quiet" href="/check">
          Check a car
        </a>
      </div>
      {note.trim().length > 0 && note.trim().length < 8 ? <p className="hint">Write a short note first, at least a few words.</p> : null}
    </form>
  );
}
