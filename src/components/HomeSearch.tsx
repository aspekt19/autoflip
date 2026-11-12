"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import type { Mode } from "@/domain/types";

/**
 * Homepage task entry: intent + mode only.
 * Find opens a SERV chat on /find. ZIP/budget are collected in chat by SERV — not on the hero.
 *
 * "For resale" routes to budget-first /resale inventory search (honest flip P&L).
 * "For me" keeps the native GET submit to /find.
 */
export function HomeSearch({ onModeChange }: { onModeChange?: (mode: Mode) => void }) {
  const [note, setNote] = useState("");
  const [mode, setMode] = useState<Mode>("personal");
  const forResale = mode === "flip";

  function choose(next: Mode) {
    setMode(next);
    onModeChange?.(next);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    if (forResale) {
      event.preventDefault();
      return;
    }
    const text = note.trim();
    if (text.length < 8) {
      event.preventDefault();
      return;
    }
    // Do not preventDefault on a valid note — browser GET to /find is the reliable path.
  }

  return (
    <form className="hero-chat" action={forResale ? "/resale" : "/find"} method="get" onSubmit={submit}>
      <fieldset className="pills" aria-label="Who is this for">
        <label className="pill">
          <input type="radio" name="home-mode" checked={!forResale} onChange={() => choose("personal")} /> For me
        </label>
        <label className="pill">
          <input type="radio" name="home-mode" checked={forResale} onChange={() => choose("flip")} /> For resale
        </label>
      </fieldset>
      {forResale ? (
        <>
          <p className="hint">
            Enter a budget. Lemonless searches what you can buy now and returns cars priced below similar listings
            (after costs), plus alternatives. 1 report credit per search. Not a profit guarantee.
          </p>
          <div className="btn-row">
            <Link className="action" href="/resale">
              Find flips
            </Link>
            <a className="quiet" href="/check">
              Check a car
            </a>
          </div>
        </>
      ) : (
        <>
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
          {note.trim().length > 0 && note.trim().length < 8 ? (
            <p className="hint">Write a short note first, at least a few words.</p>
          ) : null}
        </>
      )}
    </form>
  );
}
