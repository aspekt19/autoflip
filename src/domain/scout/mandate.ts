import type { ScoutMandate, ScoutMode } from "./types";

export type MandateValidation =
  | { ok: true; mandate: ScoutMandate }
  | { ok: false; error: "mandate_invalid"; message: string };

const REPAIR = new Set(["none", "minor", "major", "unknown"]);

function asMode(raw: unknown): ScoutMode | null {
  return raw === "personal" || raw === "flip" ? raw : null;
}

function asNonNegNumber(raw: unknown): number | null | undefined {
  if (raw === null) return null;
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return undefined;
  return raw;
}

function asMakes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 12);
}

/** Validate a personal/flip mandate. Does not invent missing facts. */
export function validateScoutMandate(raw: unknown): MandateValidation {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "mandate_invalid", message: "Mandate must be an object." };
  }
  const body = raw as Record<string, unknown>;
  const mode = asMode(body.mode);
  if (!mode) {
    return { ok: false, error: "mandate_invalid", message: "mode must be personal or flip." };
  }

  const budgetUsd = asNonNegNumber(body.budgetUsd);
  if (budgetUsd === undefined && body.budgetUsd !== undefined) {
    return { ok: false, error: "mandate_invalid", message: "budgetUsd must be a non-negative number or null." };
  }
  const budgetKnown =
    typeof body.budgetKnown === "boolean" ? body.budgetKnown : budgetUsd !== null && budgetUsd !== undefined;

  if (mode === "personal" && budgetKnown && (budgetUsd === null || budgetUsd === undefined)) {
    return {
      ok: false,
      error: "mandate_invalid",
      message: "Personal mandate marked budgetKnown requires budgetUsd.",
    };
  }

  const targetProfitUsd = asNonNegNumber(body.targetProfitUsd);
  if (targetProfitUsd === undefined && body.targetProfitUsd !== undefined) {
    return {
      ok: false,
      error: "mandate_invalid",
      message: "targetProfitUsd must be a non-negative number or null.",
    };
  }

  const repairAbility =
    typeof body.repairAbility === "string" && REPAIR.has(body.repairAbility)
      ? (body.repairAbility as ScoutMandate["repairAbility"])
      : "unknown";

  const preferredMakes = asMakes(body.preferredMakes);
  const openToOtherMakes =
    typeof body.openToOtherMakes === "boolean" ? body.openToOtherMakes : preferredMakes.length === 0;

  const zip =
    body.zip === null || body.zip === undefined
      ? null
      : typeof body.zip === "string" && /^\d{5}$/.test(body.zip.trim())
        ? body.zip.trim()
        : undefined;
  if (zip === undefined) {
    return { ok: false, error: "mandate_invalid", message: "zip must be a 5-digit US ZIP or null." };
  }

  const maxDistanceMiles = asNonNegNumber(body.maxDistanceMiles);
  if (maxDistanceMiles === undefined && body.maxDistanceMiles !== undefined) {
    return {
      ok: false,
      error: "mandate_invalid",
      message: "maxDistanceMiles must be a non-negative number or null.",
    };
  }
  if (maxDistanceMiles != null && !zip) {
    return {
      ok: false,
      error: "mandate_invalid",
      message: "maxDistanceMiles requires a zip.",
    };
  }

  const notes =
    body.notes === null || body.notes === undefined
      ? null
      : typeof body.notes === "string"
        ? body.notes.slice(0, 2000)
        : undefined;
  if (notes === undefined) {
    return { ok: false, error: "mandate_invalid", message: "notes must be a string or null." };
  }

  return {
    ok: true,
    mandate: {
      mode,
      budgetUsd: budgetUsd ?? null,
      budgetKnown,
      targetProfitUsd: targetProfitUsd ?? null,
      repairAbility,
      preferredMakes,
      openToOtherMakes,
      zip,
      maxDistanceMiles: maxDistanceMiles ?? null,
      notes,
    },
  };
}
