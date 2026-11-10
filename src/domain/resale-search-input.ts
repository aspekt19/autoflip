/**
 * Budget-first Resale search input.
 * Budget is required. Location, radius, body, makes, miles, repair skill, and time-to-sell are optional.
 */

import { parseUsdInput } from "./budget";
import {
  emptyNeed,
  parseDistanceMiles,
  REPAIR_ABILITIES,
  type RepairAbility,
  type StructuredNeed,
} from "./need";
import { NOTE_BODY_STYLES, type NoteBodyStyle } from "./note-intake";

export const TIME_TO_SELL_PREFS = ["any", "faster", "unknown"] as const;
export type TimeToSellPref = (typeof TIME_TO_SELL_PREFS)[number];

export type ResaleSearchInput = {
  budgetUsd: number;
  zip: string | null;
  distanceMiles: number | null;
  bodyStyle: NoteBodyStyle | null;
  preferredMakes: string[];
  preferredModels: Array<{ make: string; model: string }>;
  yearMin: number | null;
  yearMax: number | null;
  milesMax: number | null;
  repairAbility: RepairAbility;
  targetProfitUsd: number | null;
  timeToSell: TimeToSellPref;
  resaleChannel: "private_party" | "dealer_trade";
  /** Shopper free-text description (own words). */
  freeText: string | null;
  criteriaParseSource?: "serv" | "code" | "form";
  criteriaResponseId?: string | null;
};

export type ResaleSearchInputIssue = { field: string; message: string };

export function parseResaleSearchInput(
  raw: unknown,
): { ok: true; input: ResaleSearchInput } | { ok: false; issues: ResaleSearchInputIssue[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, issues: [{ field: "body", message: "Send a JSON object with at least budgetUsd." }] };
  }
  const body = raw as Record<string, unknown>;
  const issues: ResaleSearchInputIssue[] = [];

  const budgetRaw = body.budgetUsd ?? body.budget;
  const budget =
    budgetRaw == null || budgetRaw === ""
      ? null
      : typeof budgetRaw === "number"
        ? Number.isFinite(budgetRaw) && budgetRaw > 0
          ? Math.round(budgetRaw)
          : null
        : parseUsdInput(String(budgetRaw));
  if (budget == null || budget <= 0) {
    issues.push({ field: "budgetUsd", message: "Budget is required — enter how much cash you can spend." });
  }

  let zip: string | null = null;
  if (typeof body.zip === "string" && body.zip.trim()) {
    const z = body.zip.trim();
    if (!/^\d{5}(-\d{4})?$/.test(z)) {
      issues.push({ field: "zip", message: "ZIP must be 5 digits (optional +4)." });
    } else {
      zip = z.slice(0, 5);
    }
  }

  const distance = parseDistanceMiles(body.distanceMiles ?? body.radiusMiles ?? null);
  if (!distance.ok) {
    issues.push({ field: "distanceMiles", message: distance.message });
  } else if (distance.miles != null && !zip) {
    issues.push({ field: "zip", message: "A search radius needs a ZIP. Leave radius blank for nationwide." });
  }

  let bodyStyle: NoteBodyStyle | null = null;
  if (typeof body.bodyStyle === "string" && body.bodyStyle.trim()) {
    const key = body.bodyStyle.trim().toLowerCase();
    const matched = NOTE_BODY_STYLES.find((item) => item.toLowerCase() === key);
    if (matched) {
      bodyStyle = matched;
    } else {
      issues.push({
        field: "bodyStyle",
        message: `Body type must be one of: ${NOTE_BODY_STYLES.join(", ")}.`,
      });
    }
  }

  const preferredMakes: string[] = [];
  const makesRaw = body.preferredMakes ?? body.makes;
  if (Array.isArray(makesRaw)) {
    for (const item of makesRaw) {
      if (typeof item === "string" && item.trim()) preferredMakes.push(item.trim());
    }
  } else if (typeof makesRaw === "string" && makesRaw.trim()) {
    for (const part of makesRaw.split(/[,;/|]+/)) {
      if (part.trim()) preferredMakes.push(part.trim());
    }
  }

  const preferredModels: Array<{ make: string; model: string }> = [];
  if (Array.isArray(body.preferredModels)) {
    for (const item of body.preferredModels) {
      if (!item || typeof item !== "object") continue;
      const row = item as { make?: unknown; model?: unknown };
      if (typeof row.make === "string" && row.make.trim() && typeof row.model === "string" && row.model.trim()) {
        preferredModels.push({ make: row.make.trim(), model: row.model.trim() });
      }
    }
  }
  if (typeof body.make === "string" && body.make.trim() && typeof body.model === "string" && body.model.trim()) {
    preferredModels.push({ make: body.make.trim(), model: body.model.trim() });
  }

  let yearMin: number | null = null;
  let yearMax: number | null = null;
  if (body.yearMin != null && body.yearMin !== "") {
    const n = typeof body.yearMin === "number" ? body.yearMin : Number(body.yearMin);
    if (!Number.isFinite(n) || n < 1980) {
      issues.push({ field: "yearMin", message: "Year min must be a four-digit year, or blank." });
    } else {
      yearMin = Math.round(n);
    }
  }
  if (body.yearMax != null && body.yearMax !== "") {
    const n = typeof body.yearMax === "number" ? body.yearMax : Number(body.yearMax);
    if (!Number.isFinite(n) || n < 1980) {
      issues.push({ field: "yearMax", message: "Year max must be a four-digit year, or blank." });
    } else {
      yearMax = Math.round(n);
    }
  }
  if (yearMin != null && yearMax != null && yearMin > yearMax) {
    issues.push({ field: "yearMin", message: "Year min cannot be after year max." });
  }

  const freeText =
    typeof body.freeText === "string" && body.freeText.trim()
      ? body.freeText.trim().slice(0, 500)
      : typeof body.note === "string" && body.note.trim()
        ? body.note.trim().slice(0, 500)
        : null;

  let criteriaParseSource: ResaleSearchInput["criteriaParseSource"];
  if (body.criteriaParseSource === "serv" || body.criteriaParseSource === "code" || body.criteriaParseSource === "form") {
    criteriaParseSource = body.criteriaParseSource;
  }
  const criteriaResponseId =
    typeof body.criteriaResponseId === "string" && body.criteriaResponseId.trim()
      ? body.criteriaResponseId.trim()
      : null;

  let milesMax: number | null = null;
  if (body.milesMax != null && body.milesMax !== "") {
    const n = typeof body.milesMax === "number" ? body.milesMax : Number(String(body.milesMax).replace(/[^0-9.]/g, ""));
    if (!Number.isFinite(n) || n <= 0) {
      issues.push({ field: "milesMax", message: "Max mileage must be a positive number, or blank." });
    } else {
      milesMax = Math.round(n);
    }
  }

  let repairAbility: RepairAbility = "unknown";
  if (typeof body.repairAbility === "string" && body.repairAbility.trim()) {
    const skill = body.repairAbility.trim().toLowerCase();
    if ((REPAIR_ABILITIES as readonly string[]).includes(skill)) {
      repairAbility = skill as RepairAbility;
    } else {
      issues.push({
        field: "repairAbility",
        message: `Repair willingness must be one of: ${REPAIR_ABILITIES.join(", ")}.`,
      });
    }
  }

  let targetProfitUsd: number | null = null;
  if (body.targetProfitUsd != null && body.targetProfitUsd !== "") {
    const profitRaw = body.targetProfitUsd;
    const profit =
      typeof profitRaw === "number"
        ? Number.isFinite(profitRaw) && profitRaw >= 0
          ? Math.round(profitRaw)
          : null
        : parseUsdInput(String(profitRaw));
    if (profit == null || profit < 0) {
      issues.push({ field: "targetProfitUsd", message: "Target profit must be a dollar amount, or blank." });
    } else {
      targetProfitUsd = profit;
    }
  }

  let timeToSell: TimeToSellPref = "any";
  if (typeof body.timeToSell === "string" && body.timeToSell.trim()) {
    const t = body.timeToSell.trim().toLowerCase();
    if ((TIME_TO_SELL_PREFS as readonly string[]).includes(t)) {
      timeToSell = t as TimeToSellPref;
    } else {
      issues.push({ field: "timeToSell", message: "Time to sell must be any, faster, or unknown." });
    }
  }

  let resaleChannel: "private_party" | "dealer_trade" = "private_party";
  if (typeof body.resaleChannel === "string" && body.resaleChannel.trim()) {
    const c = body.resaleChannel.trim().toLowerCase();
    if (c === "private_party" || c === "dealer_trade") {
      resaleChannel = c;
    } else {
      issues.push({ field: "resaleChannel", message: "Resale channel must be private_party or dealer_trade." });
    }
  }

  if (issues.length > 0 || budget == null) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    input: {
      budgetUsd: budget,
      zip,
      distanceMiles: distance.ok ? distance.miles : null,
      bodyStyle,
      preferredMakes,
      preferredModels,
      yearMin,
      yearMax,
      milesMax,
      repairAbility,
      targetProfitUsd,
      timeToSell,
      resaleChannel,
      freeText,
      criteriaParseSource,
      criteriaResponseId,
    },
  };
}

/** Map Resale search input into a Find flip StructuredNeed for inventory search. */
export function needFromResaleSearchInput(input: ResaleSearchInput): StructuredNeed {
  const noteParts = [
    input.freeText,
    `Flip budget $${input.budgetUsd.toLocaleString("en-US")}.`,
    input.zip ? `Near ${input.zip}.` : "Nationwide search.",
    input.bodyStyle ? `Prefer ${input.bodyStyle.replace(/_/g, " ")}.` : null,
    input.preferredMakes.length ? `Prefer makes: ${input.preferredMakes.join(", ")}.` : null,
    input.preferredModels.length
      ? `Prefer models: ${input.preferredModels.map((m) => `${m.make} ${m.model}`).join(", ")}.`
      : null,
    input.yearMin != null || input.yearMax != null
      ? `Years ${input.yearMin ?? "any"}–${input.yearMax ?? "any"}.`
      : null,
    input.milesMax != null ? `Max ${input.milesMax.toLocaleString("en-US")} miles.` : null,
    input.timeToSell === "faster" ? "Prefer faster-turning inventory when ranking." : null,
  ].filter(Boolean);

  const models = input.preferredModels;
  return {
    ...emptyNeed("flip"),
    note: noteParts.join(" "),
    budgetUsd: input.budgetUsd,
    budgetKnown: true,
    budgetScope: "car",
    zip: input.zip,
    distanceMiles: input.distanceMiles,
    repairAbility: input.repairAbility,
    targetProfitUsd: input.targetProfitUsd,
    milesMax: input.milesMax,
    milesCapResolved: input.milesMax != null,
    bodyStyle: input.bodyStyle,
    preferredMakes: input.preferredMakes.length
      ? input.preferredMakes
      : [...new Set(models.map((m) => m.make))],
    make: input.preferredMakes[0] ?? models[0]?.make ?? null,
    preferredModels: models,
    preferredModelsSource: models.length ? "user_note" : "none",
    openToOtherMakes: input.preferredMakes.length === 0 && models.length === 0,
    yearMin: input.yearMin,
    yearMax: input.yearMax,
    yearBandResolved: true,
  };
}
