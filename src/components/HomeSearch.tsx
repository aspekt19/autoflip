"use client";

import { useState, type FormEvent } from "react";
import type { Mode } from "@/domain/types";

/**
 * Homepage task entry: intent + mode only.
 * ZIP and seller-distance radius are collected later in /find (budget → confirm)
 * before geographically constrained inventory runs — not on the hero.
 *
 * Native GET submit is the navigation contract. Client soft-nav alone previously
 * left the page unchanged when the App Router soft-push failed after preventDefault.
 */
export function HomeSearch({ onModeChange }: { onModeChange?: (mode: Mode) => void }) {
  const [note, setNote] = useState("");
  const [mode, setMode] = useState<Mode>("personal");

  function choose(next: Mode) {
    setMode(next);
    onModeChange?.(next);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    const text = note.trim();
    if (text.length < 8) {
      event.preventDefault();
      return;
    }
    // Do not preventDefault on a valid note — browser GET to /find is the reliable path.
    // Sync the controlled textarea value into the named field (already bound via value=).
  }

  return (
    <form className="hero-chat" action="/find" method="get" onSubmit={submit}>
      <fieldset className="pills" aria-label="Who is this for">
        <label className="pill">
          <input type="radio" name="home-mode" checked={mode === "personal"} onChange={() => choose("personal")} /> For me
        </label>
        <label className="pill">
          <input type="radio" name="home-mode" checked={mode === "flip"} onChange={() => choose("flip")} /> For resale
        </label>
      </fieldset>
      {/* Radio name differs from query key so only the hidden mode field is submitted. */}
      <input type="hidden" name="mode" value={mode} />
      <label className="sr-only" htmlFor="home-note">
        Describe the car you need
      </label>
      <textarea
        id="home-note"
        name="note"
        rows={3}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="Describe the car you need. A reliable SUV under $20,000 near Dallas…"
        minLength={8}
        required
      />
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
