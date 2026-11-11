"use client";

import { useRef, useState } from "react";
import { CONDITION_HINT, YEAR_HINT_BLANK, YEAR_HINT_NO_FLOOR, yearHintKnown } from "@/domain/intake-copy";
import { milesDraftState, priceDraftState, yearDraftState } from "@/domain/numeric-draft";
import type { HistoryPref, NoteBodyStyle, TransmissionPref } from "@/domain/note-intake";
import { NOTE_BODY_STYLES } from "@/domain/note-intake";
import type { StructuredNeed } from "@/domain/need";

export function FromNote({ show }: { show: boolean }) {
  if (!show) return null;
  return <span className="from-note">from your note</span>;
}

export function YearFloorField({
  id = "year-min-edit",
  yearMin,
  yearBandResolved,
  marked = false,
  onCommit,
}: {
  id?: string;
  yearMin: number | null;
  yearBandResolved: boolean;
  marked?: boolean;
  onCommit: (next: { yearMin: number | null; yearBandResolved: boolean }) => void;
}) {
  const [draft, setDraft] = useState(yearMin != null ? String(yearMin) : "");
  const [final, setFinal] = useState(false);
  const dirty = useRef(false);
  const state = yearDraftState(draft, { final });
  const showNoFloor = draft.trim() === "" && yearBandResolved && yearMin == null && !dirty.current;
  const hint = state.error
    ? null
    : state.yearMin != null
      ? yearHintKnown(state.yearMin)
      : showNoFloor
        ? YEAR_HINT_NO_FLOOR
        : YEAR_HINT_BLANK;
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;

  function commit(nextDraft: string, isFinal: boolean) {
    const parsed = yearDraftState(nextDraft, { final: isFinal });
    const keptNoFloor = parsed.yearMin == null && nextDraft.trim() === "" && yearBandResolved && !dirty.current;
    onCommit({
      yearMin: parsed.yearMin,
      yearBandResolved: parsed.yearMin != null ? true : keptNoFloor,
    });
  }

  return (
    <div className="field">
      <label htmlFor={id}>
        Oldest model year (optional) <FromNote show={marked} />
      </label>
      <input
        id={id}
        name="yearMin"
        type="text"
        inputMode="numeric"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        value={draft}
        placeholder="e.g. 2015"
        aria-invalid={state.error ? true : undefined}
        aria-describedby={state.error ? errorId : hint ? hintId : undefined}
        onChange={(event) => {
          const next = event.target.value;
          dirty.current = true;
          setDraft(next);
          setFinal(false);
          commit(next, false);
        }}
        onBlur={() => {
          setFinal(true);
          commit(draft, true);
        }}
      />
      {state.error ? (
        <p id={errorId} className="warn" role="alert">
          {state.error}
        </p>
      ) : hint ? (
        <p id={hintId} className="hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function PriceDraftField({
  id,
  label,
  budgetUsd,
  marked = false,
  onCommit,
}: {
  id: string;
  label: string;
  budgetUsd: number | null;
  marked?: boolean;
  onCommit: (next: { budgetUsd: number | null; budgetKnown: boolean }) => void;
}) {
  const [draft, setDraft] = useState(budgetUsd != null ? budgetUsd.toLocaleString("en-US") : "");
  const [final, setFinal] = useState(false);
  const state = priceDraftState(draft, { final });
  const errorId = `${id}-error`;
  return (
    <div className="field">
      <label htmlFor={id}>
        {label} <FromNote show={marked} />
      </label>
      <input
        id={id}
        name={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        value={draft}
        placeholder="e.g. 18000"
        aria-invalid={state.error ? true : undefined}
        aria-describedby={state.error ? errorId : undefined}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          setFinal(false);
          const parsed = priceDraftState(next, { final: false });
          if (parsed.budgetKnown || next.trim() === "") {
            onCommit({ budgetUsd: parsed.budgetUsd, budgetKnown: parsed.budgetKnown });
          }
        }}
        onBlur={() => setFinal(true)}
      />
      {state.error ? (
        <p id={errorId} className="warn" role="alert">
          {state.error}
        </p>
      ) : null}
    </div>
  );
}

export function MilesDraftField({
  id = "miles-edit",
  milesMax,
  marked = false,
  onCommit,
}: {
  id?: string;
  milesMax: number | null;
  marked?: boolean;
  onCommit: (next: { milesMax: number | null; milesCapResolved: boolean }) => void;
}) {
  const [draft, setDraft] = useState(milesMax != null ? milesMax.toLocaleString("en-US") : "");
  const [final, setFinal] = useState(false);
  const state = milesDraftState(draft, { final });
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  return (
    <div className="field">
      <label htmlFor={id}>
        Maximum mileage in miles (optional) <FromNote show={marked} />
      </label>
      <input
        id={id}
        name="milesMax"
        type="text"
        inputMode="numeric"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        value={draft}
        placeholder="e.g. 80,000 miles"
        aria-invalid={state.error ? true : undefined}
        aria-describedby={state.error ? errorId : hintId}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          setFinal(false);
          const parsed = milesDraftState(next, { final: false });
          if (parsed.milesMax != null || next.trim() === "") {
            onCommit({ milesMax: parsed.milesMax, milesCapResolved: true });
          }
        }}
        onBlur={() => setFinal(true)}
      />
      {state.error ? (
        <p id={errorId} className="warn" role="alert">
          {state.error}
        </p>
      ) : (
        <p id={hintId} className="hint">
          Odometer miles, not kilometers.
        </p>
      )}
    </div>
  );
}

const HISTORY_OPTIONS: Array<{ value: HistoryPref; label: string }> = [
  { value: "no_salvage_no_accidents", label: "No salvage, no accident history" },
  { value: "no_salvage", label: "No salvage" },
  { value: "no_accidents", label: "No accident history" },
];

export function NoteFactChips({
  need,
  onChange,
}: {
  need: StructuredNeed;
  onChange: (next: StructuredNeed) => void;
}) {
  const keep = useRef({
    transmission: need.transmission != null,
    fuel: need.fuelEconomyPriority === true,
    awd: need.awdPreference === true,
    reliability: need.reliabilityPriority === true,
    history: need.historyPreference != null,
    body: need.bodyStyle != null,
    location: Boolean(need.locationPhrase),
  });
  if (
    !keep.current.transmission &&
    !keep.current.fuel &&
    !keep.current.awd &&
    !keep.current.reliability &&
    !keep.current.history &&
    !keep.current.body &&
    !keep.current.location
  ) {
    return null;
  }
  return (
    <div className="note-facts" role="group" aria-label="From your note">
      <p className="note-facts-title">From your note</p>
      {keep.current.transmission ? (
        <label className="note-chip">
          <span className="from-note">from your note</span>
          Transmission
          <select
            aria-label="Transmission"
            value={need.transmission ?? ""}
            onChange={(event) => {
              const value = event.target.value;
              const transmission: TransmissionPref | null =
                value === "automatic" || value === "manual" ? value : null;
              onChange({ ...need, transmission });
            }}
          >
            <option value="">Not set</option>
            <option value="automatic">Automatic</option>
            <option value="manual">Manual</option>
          </select>
        </label>
      ) : null}
      {keep.current.fuel ? (
        <label className="note-chip check-line">
          <span className="from-note">from your note</span>
          <span className="check-line">
            <input
              type="checkbox"
              checked={need.fuelEconomyPriority === true}
              onChange={(event) => onChange({ ...need, fuelEconomyPriority: event.target.checked })}
            />
            Fuel economy
          </span>
        </label>
      ) : null}
      {keep.current.awd ? (
        <label className="note-chip check-line">
          <span className="from-note">from your note</span>
          <span className="check-line">
            <input
              type="checkbox"
              checked={need.awdPreference === true}
              onChange={(event) => onChange({ ...need, awdPreference: event.target.checked })}
            />
            Preferably AWD
          </span>
        </label>
      ) : null}
      {keep.current.reliability ? (
        <label className="note-chip check-line">
          <span className="from-note">from your note</span>
          <span className="check-line">
            <input
              type="checkbox"
              checked={need.reliabilityPriority === true}
              onChange={(event) => onChange({ ...need, reliabilityPriority: event.target.checked })}
            />
            Reliability
          </span>
        </label>
      ) : null}
      {keep.current.history ? (
        <label className="note-chip">
          <span className="from-note">from your note</span>
          History
          <select
            aria-label="History"
            value={need.historyPreference ?? ""}
            onChange={(event) => {
              const value = event.target.value;
              const historyPreference: HistoryPref | null =
                value === "no_salvage" || value === "no_accidents" || value === "no_salvage_no_accidents"
                  ? value
                  : null;
              onChange({
                ...need,
                historyPreference,
                conditionPriority: historyPreference ? "inspection_first" : "unspecified",
              });
            }}
          >
            <option value="">Not set</option>
            {HISTORY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {keep.current.body ? (
        <label className="note-chip">
          <span className="from-note">from your note</span>
          Body
          <select
            aria-label="Body"
            value={need.bodyStyle ?? ""}
            onChange={(event) => {
              const value = event.target.value;
              const bodyStyle = NOTE_BODY_STYLES.find((item) => item === value) ?? null;
              onChange({ ...need, bodyStyle });
            }}
          >
            <option value="">Not set</option>
            {NOTE_BODY_STYLES.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {keep.current.location ? (
        <label className="note-chip">
          <span className="from-note">from your note</span>
          Location
          <input
            aria-label="Location"
            type="text"
            value={need.locationPhrase ?? ""}
            onChange={(event) => onChange({ ...need, locationPhrase: event.target.value.trim() ? event.target.value : null })}
          />
        </label>
      ) : null}
    </div>
  );
}

export { CONDITION_HINT };
