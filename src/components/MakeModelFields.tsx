"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { yearChoices } from "@/domain/vehicle-names";

type Props = {
  make: string;
  model: string;
  yearMin: string;
  yearMax: string;
  onMake: (value: string) => void;
  onModel: (value: string) => void;
  onYearMin: (value: string) => void;
  onYearMax: (value: string) => void;
  allowAnyModel?: boolean;
  anyMakeLabel?: string;
};

export function MakeModelFields({
  make,
  model,
  yearMin,
  yearMax,
  onMake,
  onModel,
  onYearMin,
  onYearMax,
  allowAnyModel = true,
  anyMakeLabel = "Not sure / Any",
}: Props) {
  const id = useId();
  const [makes, setMakes] = useState<string[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [makeFilter, setMakeFilter] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const years = useMemo(() => yearChoices(), []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/vehicles/makes")
      .then((response) => response.json())
      .then((body: { makes?: string[]; source?: string }) => {
        if (cancelled) return;
        setMakes(body.makes ?? []);
        if (body.source === "bundled") setNote("Make list is the offline backup. The vehicle catalog did not respond.");
      })
      .catch(() => {
        if (!cancelled) setNote("Make list is the offline backup. The vehicle catalog did not respond.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!make) {
      setModels([]);
      return;
    }
    const year = yearMin && yearMin === yearMax ? yearMin : "";
    const params = new URLSearchParams({ make });
    if (year) params.set("year", year);
    let cancelled = false;
    fetch(`/api/vehicles/models?${params.toString()}`)
      .then((response) => response.json())
      .then((body: { models?: string[] }) => {
        if (!cancelled) setModels(body.models ?? []);
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, [make, yearMin, yearMax]);

  const shownMakes = makes.filter((item) => item.toLowerCase().includes(makeFilter.trim().toLowerCase()));
  const shownModels = models.filter((item) => item.toLowerCase().includes(modelFilter.trim().toLowerCase()));

  return (
    <>
      <div className="field">
        <label htmlFor={`${id}-make-filter`}>Make</label>
        <input
          id={`${id}-make-filter`}
          value={makeFilter}
          onChange={(event) => setMakeFilter(event.target.value)}
          placeholder="Filter makes"
          autoComplete="off"
        />
        <select
          id={`${id}-make`}
          aria-label="Make"
          value={makes.includes(make) ? make : ""}
          onChange={(event) => {
            onMake(event.target.value);
            onModel("");
            setModelFilter("");
          }}
        >
          <option value="">{anyMakeLabel}</option>
          {shownMakes.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`${id}-model-filter`}>Model</label>
        <input
          id={`${id}-model-filter`}
          value={modelFilter}
          onChange={(event) => setModelFilter(event.target.value)}
          placeholder={make ? "Filter models" : "Choose a make first"}
          disabled={!make}
          autoComplete="off"
        />
        <select
          id={`${id}-model`}
          aria-label="Model"
          value={model}
          disabled={!make}
          onChange={(event) => onModel(event.target.value)}
        >
          {allowAnyModel ? <option value="">Any model</option> : <option value="">Choose a model</option>}
          {shownModels.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </div>
      <div className="pair">
        <div className="field">
          <label htmlFor={`${id}-year-min`}>Year from</label>
          <select id={`${id}-year-min`} value={yearMin} onChange={(event) => onYearMin(event.target.value)}>
            <option value="">Any</option>
            {years.map((year) => (
              <option key={year} value={String(year)}>
                {year}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${id}-year-max`}>Year to</label>
          <select id={`${id}-year-max`} value={yearMax} onChange={(event) => onYearMax(event.target.value)}>
            <option value="">Any</option>
            {years.map((year) => (
              <option key={year} value={String(year)}>
                {year}
              </option>
            ))}
          </select>
        </div>
      </div>
      {note ? <p className="hint">{note}</p> : null}
    </>
  );
}
