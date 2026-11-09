"use client";

import { useEffect, useId, useState } from "react";
import { customMilesBuyerHint } from "@/domain/find-buyer-copy";
import {
  MAX_DISTANCE_MILES,
  SEARCH_RADII_MILES,
  parseDistanceMiles,
} from "@/domain/need";

export const SELLER_DISTANCE_HINT =
  "Seller distance from your ZIP — not delivery or shipping. Listings without a known distance are labeled unknown; they are not treated as proven in-radius.";

type RadiusMode = "nationwide" | "preset" | "custom";

function modeFromMiles(miles: number | null): RadiusMode {
  if (miles == null) return "nationwide";
  if ((SEARCH_RADII_MILES as readonly number[]).includes(miles)) return "preset";
  return "custom";
}

export type ZipRadiusFieldsProps = {
  zip: string;
  /** Null = nationwide. Positive miles = seller-distance radius. */
  distanceMiles: number | null;
  onZipChange: (zip: string) => void;
  onDistanceChange: (miles: number | null) => void;
  disabled?: boolean;
  idPrefix?: string;
  /** When true, choosing Nationwide also clears ZIP (Scout-style). */
  nationwideClearsZip?: boolean;
  /** When true, ZIP is required whenever a radius is set. */
  zipRequiredWithRadius?: boolean;
  /**
   * When false, Nationwide is not offered (e.g. Deal Radar watches require a numeric radius).
   * Default true.
   */
  allowNationwide?: boolean;
  /** Shown beside the ZIP label when the ZIP was read from the shopper's note. */
  zipMark?: string | null;
};

/**
 * Shared ZIP + seller-distance radius control for find/check and Scout.
 * Presets, custom positive miles, and nationwide — no silent snap to presets.
 */
export function ZipRadiusFields({
  zip,
  distanceMiles,
  onZipChange,
  onDistanceChange,
  disabled = false,
  idPrefix,
  nationwideClearsZip = false,
  zipRequiredWithRadius = true,
  allowNationwide = true,
  zipMark = null,
}: ZipRadiusFieldsProps) {
  const autoId = useId();
  const prefix = idPrefix ?? autoId;
  const zipId = `${prefix}-zip`;
  const radiusId = `${prefix}-radius`;
  const customId = `${prefix}-custom-radius`;

  const initialMode = modeFromMiles(distanceMiles);
  const [mode, setMode] = useState<RadiusMode>(
    !allowNationwide && initialMode === "nationwide" ? "preset" : initialMode,
  );
  const [customDraft, setCustomDraft] = useState(
    initialMode === "custom" && distanceMiles != null ? String(distanceMiles) : "",
  );
  const [customError, setCustomError] = useState<string | null>(null);

  // Keep local mode in sync when parent resets (e.g. refine / clear).
  useEffect(() => {
    const next = modeFromMiles(distanceMiles);
    if (!allowNationwide && next === "nationwide") {
      // Radar-style: numeric radius required — nudge to default preset without inventing miles into parent.
      setMode("preset");
      setCustomDraft("");
      setCustomError(null);
      return;
    }
    setMode(next);
    if (next === "custom" && distanceMiles != null) {
      // Do not replace an in-progress draft with the normalized number ("010" must stay "010").
      setCustomDraft((current) => {
        const parsed = parseDistanceMiles(current.trim());
        if (parsed.ok && parsed.miles === distanceMiles) return current;
        return String(distanceMiles);
      });
      return;
    }
    if (next === "nationwide") {
      setCustomDraft("");
      setCustomError(null);
    }
  }, [distanceMiles, allowNationwide]);

  function selectNationwide() {
    if (!allowNationwide) {
      setCustomError("Deal Radar watches need a seller-distance radius (not nationwide).");
      return;
    }
    setMode("nationwide");
    setCustomError(null);
    setCustomDraft("");
    onDistanceChange(null);
    if (nationwideClearsZip) onZipChange("");
  }

  function selectPreset(miles: number) {
    setMode("preset");
    setCustomError(null);
    setCustomDraft("");
    onDistanceChange(miles);
  }

  function selectCustom() {
    setMode("custom");
    if (distanceMiles != null && !(SEARCH_RADII_MILES as readonly number[]).includes(distanceMiles)) {
      setCustomDraft(String(distanceMiles));
    }
  }

  function commitCustom(raw: string) {
    setCustomDraft(raw);
    const parsed = parseDistanceMiles(raw.trim() === "" ? "" : raw);
    if (!parsed.ok) {
      setCustomError(parsed.message);
      return;
    }
    if (parsed.miles == null) {
      setCustomError("Enter a positive number of miles, or choose Nationwide.");
      return;
    }
    setCustomError(null);
    onDistanceChange(parsed.miles);
  }

  const radiusSelectValue =
    mode === "nationwide"
      ? "nationwide"
      : mode === "custom"
        ? "custom"
        : String(distanceMiles ?? (allowNationwide ? "" : "50"));

  return (
    <div className="zip-radius-fields">
      <div className="field">
        <label htmlFor={zipId}>
          U.S. ZIP code{zipMark ? <span className="from-note">{zipMark}</span> : null}
        </label>
        <input
          id={zipId}
          name="zip"
          type="text"
          inputMode="numeric"
          autoComplete="postal-code"
          autoCorrect="off"
          spellCheck={false}
          value={zip}
          disabled={disabled || (nationwideClearsZip && mode === "nationwide")}
          placeholder={mode === "nationwide" ? "Optional when nationwide" : "e.g. 02101"}
          onChange={(event) => {
            const next = event.target.value;
            onZipChange(next);
            if (next.trim() && mode === "nationwide" && !nationwideClearsZip) {
              // Typing a ZIP while nationwide stays nationwide until they pick a radius.
            }
          }}
          aria-describedby={`${prefix}-zip-hint`}
        />
        <p id={`${prefix}-zip-hint`} className="hint">
          {mode === "nationwide"
            ? "Nationwide search — ZIP is optional context only."
            : zipRequiredWithRadius
              ? "Required for a mileage radius. Leading zeros are kept (e.g. 02101)."
              : "Used as the center for seller-distance radius."}
        </p>
      </div>

      <div className="field">
        <label htmlFor={radiusId}>Seller distance radius</label>
        <select
          id={radiusId}
          value={radiusSelectValue}
          disabled={disabled}
          onChange={(event) => {
            const value = event.target.value;
            if (value === "nationwide") {
              selectNationwide();
              return;
            }
            if (value === "custom") {
              selectCustom();
              return;
            }
            selectPreset(Number(value));
          }}
          aria-describedby={`${prefix}-radius-hint`}
        >
          {allowNationwide ? <option value="nationwide">Nationwide</option> : null}
          {SEARCH_RADII_MILES.map((miles) => (
            <option key={miles} value={miles}>
              {miles} miles
            </option>
          ))}
          <option value="custom">Custom…</option>
        </select>
        {mode === "custom" ? (
          <label className="block" htmlFor={customId} style={{ marginTop: 8 }}>
            Custom miles (up to {MAX_DISTANCE_MILES.toLocaleString("en-US")} mi)
            <input
              id={customId}
              name="distanceMiles"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              value={customDraft}
              disabled={disabled}
              placeholder="e.g. 137"
              onChange={(event) => commitCustom(event.target.value)}
              aria-invalid={Boolean(customError)}
              aria-describedby={customError ? `${prefix}-custom-error` : undefined}
            />
          </label>
        ) : null}
        {customError ? (
          <p id={`${prefix}-custom-error`} className="warn" role="alert">
            {customError}
          </p>
        ) : null}
        <p id={`${prefix}-radius-hint`} className="hint">
          {SELLER_DISTANCE_HINT}
          {!allowNationwide
            ? " Nationwide watches are not supported here — pick a positive seller-distance radius."
            : ` ${customMilesBuyerHint(MAX_DISTANCE_MILES)}`}
        </p>
      </div>
    </div>
  );
}
