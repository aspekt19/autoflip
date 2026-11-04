import { parseUsdInput } from "./budget";

export const USE_CASES = ["family", "commute", "haul", "first_car", "comfort", "unspecified"] as const;
export type UseCase = (typeof USE_CASES)[number];

export const REPAIR_ABILITIES = ["none", "minor", "major", "unknown"] as const;
export type RepairAbility = (typeof REPAIR_ABILITIES)[number];

export const BUDGET_SCOPES = ["car", "all_in", "unspecified"] as const;
export type BudgetScope = (typeof BUDGET_SCOPES)[number];

/** What the shopper said. Repair ability is not a risk tolerance. */
export type StructuredNeed = {
  mode: "personal" | "flip";
  useCase: UseCase;
  note: string;
  budgetUsd: number | null;
  budgetKnown: boolean;
  budgetScope: BudgetScope;
  mustHaves: string[];
  priorities: string[];
  zip: string | null;
  repairAbility: RepairAbility;
  targetProfitUsd: number | null;
};

export type NeedIssue = { field: string; message: string };

const ZIP = /^\d{5}$/;

export function emptyNeed(mode: "personal" | "flip" = "personal"): StructuredNeed {
  return {
    mode,
    useCase: "unspecified",
    note: "",
    budgetUsd: null,
    budgetKnown: false,
    budgetScope: "unspecified",
    mustHaves: [],
    priorities: [],
    zip: null,
    repairAbility: "unknown",
    targetProfitUsd: null,
  };
}

export function validateNeed(input: unknown): { ok: true; need: StructuredNeed } | { ok: false; issues: NeedIssue[] } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, issues: [{ field: "need", message: "The need has to be an object." }] };
  }
  const raw = input as Record<string, unknown>;
  const issues: NeedIssue[] = [];
  if (raw.mode !== "personal" && raw.mode !== "flip") issues.push({ field: "mode", message: "Choose For me or For resale." });
  if (typeof raw.useCase !== "string" || !USE_CASES.includes(raw.useCase as UseCase)) {
    issues.push({ field: "useCase", message: "Choose what the car is for, or leave it unspecified." });
  }
  const note = typeof raw.note === "string" ? raw.note.trim().slice(0, 500) : "";
  let budgetUsd: number | null = null;
  let budgetKnown = false;
  if (raw.budgetUsd === null || raw.budgetUsd === undefined || raw.budgetUsd === "") {
    budgetUsd = null;
  } else if (typeof raw.budgetUsd === "number" && Number.isFinite(raw.budgetUsd) && raw.budgetUsd >= 1000 && raw.budgetUsd <= 250_000) {
    budgetUsd = Math.round(raw.budgetUsd);
    budgetKnown = true;
  } else {
    issues.push({ field: "budgetUsd", message: "Budget has to be a dollar amount, or left blank." });
  }
  if (raw.budgetKnown === false) budgetKnown = false;
  const budgetScope = BUDGET_SCOPES.includes(raw.budgetScope as BudgetScope) ? (raw.budgetScope as BudgetScope) : "unspecified";
  const mustHaves = stringList(raw.mustHaves);
  const priorities = stringList(raw.priorities);
  let zip: string | null = null;
  if (raw.zip === null || raw.zip === undefined || raw.zip === "") zip = null;
  else if (typeof raw.zip === "string" && ZIP.test(raw.zip.trim())) zip = raw.zip.trim();
  else issues.push({ field: "zip", message: "ZIP needs to be 5 digits, or left blank." });
  const repairAbility = REPAIR_ABILITIES.includes(raw.repairAbility as RepairAbility)
    ? (raw.repairAbility as RepairAbility)
    : "unknown";
  let targetProfitUsd: number | null = null;
  if (raw.targetProfitUsd === null || raw.targetProfitUsd === undefined || raw.targetProfitUsd === "") targetProfitUsd = null;
  else if (typeof raw.targetProfitUsd === "number" && Number.isFinite(raw.targetProfitUsd) && raw.targetProfitUsd >= 0 && raw.targetProfitUsd <= 50_000) {
    targetProfitUsd = Math.round(raw.targetProfitUsd);
  } else issues.push({ field: "targetProfitUsd", message: "Target profit has to be a dollar amount, or left blank." });
  if ("riskTolerance" in raw) issues.push({ field: "riskTolerance", message: "Repair ability is not a risk tolerance." });
  if (issues.length) return { ok: false, issues };
  const mode = raw.mode === "flip" ? "flip" : "personal";
  const useCase = USE_CASES.includes(raw.useCase as UseCase) ? (raw.useCase as UseCase) : "unspecified";
  return {
    ok: true,
    need: {
      mode,
      useCase,
      note,
      budgetUsd: budgetKnown ? budgetUsd : null,
      budgetKnown,
      budgetScope,
      mustHaves,
      priorities,
      zip,
      repairAbility,
      targetProfitUsd,
    },
  };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 6)
    .map((item) => item.slice(0, 80));
}

/** Read a budget the shopper actually wrote. Does not guess a number that is not there. */
export function budgetFromText(text: string): number | null {
  const match = text.match(/(?:\$\s*|(?:\bunder\b|\bbudget\b)\s+\$?\s*)([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,6})\b/i);
  if (!match) return null;
  const value = Number(match[1]!.replace(/,/g, ""));
  if (!Number.isFinite(value) || value < 1000 || value > 250_000) return null;
  return value;
}

export function useCaseFromText(text: string): UseCase {
  const t = text.toLowerCase();
  if (/\b(kids?|family|school|car seat|third row)\b/.test(t)) return "family";
  if (/\b(truck|haul|towing|tow|cargo)\b/.test(t)) return "haul";
  if (/\b(commute|city driving|mpg|fuel economy)\b/.test(t)) return "commute";
  if (/\b(first car|beater)\b/.test(t)) return "first_car";
  if (/\b(comfort|quiet cabin)\b/.test(t)) return "comfort";
  return "unspecified";
}

export function repairFromText(text: string): RepairAbility {
  const t = text.toLowerCase();
  if (/\b(no repairs|can't repair|cannot repair|dealer only)\b/.test(t)) return "none";
  if (/\b(minor repairs?|small repairs?)\b/.test(t)) return "minor";
  if (/\b(do my own repairs|i can repair|major repairs)\b/.test(t)) return "major";
  return "unknown";
}

export function explicitNeedFromText(text: string, mode: "personal" | "flip"): StructuredNeed {
  const budget = budgetFromText(text);
  return {
    ...emptyNeed(mode),
    useCase: useCaseFromText(text),
    note: text.trim().slice(0, 500),
    budgetUsd: budget,
    budgetKnown: budget !== null,
    repairAbility: mode === "flip" ? repairFromText(text) : "unknown",
  };
}

export type FollowUp = { id: "zip" | "use" | "repair" | "profit" | "cash"; prompt: string };

export function followUps(need: StructuredNeed): FollowUp[] {
  if (need.mode === "flip") {
    const questions: FollowUp[] = [];
    if (need.targetProfitUsd === null) {
      questions.push({ id: "profit", prompt: "What profit do you want after fees and reconditioning?" });
    }
    if (need.repairAbility === "unknown") {
      questions.push({ id: "repair", prompt: "What repair work can you do? This changes the reconditioning assumption, not a risk level." });
    }
    if (!need.budgetKnown) {
      questions.push({ id: "cash", prompt: "How much cash can you put into the car?" });
    }
    if (!need.zip && questions.length < 3) {
      questions.push({ id: "zip", prompt: "What ZIP should we shop around?" });
    }
    return questions.slice(0, 3);
  }
  const questions: FollowUp[] = [];
  if (!need.zip) {
    questions.push({ id: "zip", prompt: "What ZIP should we shop around?" });
  }
  if (need.useCase === "unspecified") {
    questions.push({ id: "use", prompt: "What will you use the car for most?" });
  }
  return questions.slice(0, 2);
}

export function applyFollowUp(need: StructuredNeed, id: FollowUp["id"], value: string): StructuredNeed {
  if (id === "zip") return { ...need, zip: ZIP.test(value.trim()) ? value.trim() : need.zip };
  if (id === "use" && USE_CASES.includes(value as UseCase)) return { ...need, useCase: value as UseCase };
  if (id === "repair" && REPAIR_ABILITIES.includes(value as RepairAbility)) return { ...need, repairAbility: value as RepairAbility };
  if (id === "profit" || id === "cash") {
    const amount = parseUsdInput(value);
    if (amount !== null && amount <= 50_000) {
      if (id === "cash") return { ...need, budgetUsd: amount, budgetKnown: true };
      return { ...need, targetProfitUsd: amount };
    }
  }
  return need;
}

/** Form fields the shopper typed win over anything extracted from a paragraph. */
export function overlayExplicit(
  extracted: StructuredNeed,
  explicit: Partial<Pick<StructuredNeed, "mode" | "budgetUsd" | "budgetKnown" | "budgetScope" | "zip" | "repairAbility" | "useCase" | "targetProfitUsd">>,
): StructuredNeed {
  return {
    ...extracted,
    mode: explicit.mode ?? extracted.mode,
    budgetUsd: explicit.budgetKnown === false ? null : explicit.budgetUsd ?? extracted.budgetUsd,
    budgetKnown: explicit.budgetKnown ?? extracted.budgetKnown,
    budgetScope: explicit.budgetScope ?? extracted.budgetScope,
    zip: explicit.zip === undefined ? extracted.zip : explicit.zip,
    repairAbility: explicit.repairAbility ?? extracted.repairAbility,
    useCase: explicit.useCase && explicit.useCase !== "unspecified" ? explicit.useCase : extracted.useCase,
    targetProfitUsd: explicit.targetProfitUsd === undefined ? extracted.targetProfitUsd : explicit.targetProfitUsd,
  };
}

export function parseNeedJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced?.[1] ?? text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no json");
  return JSON.parse(body.slice(start, end + 1));
}

export function yearBandForBudget(budgetUsd: number | null, now = new Date()): { yearMin: number; yearMax: number; because: string } {
  const cap = now.getUTCFullYear() + 1;
  if (budgetUsd === null) return { yearMin: 2012, yearMax: Math.min(2020, cap), because: "No budget was given, so this is only a starting year band." };
  if (budgetUsd < 12_000) return { yearMin: 2008, yearMax: 2016, because: "Under $12,000, the guidance table starts with older model years." };
  if (budgetUsd < 20_000) {
    return {
      yearMin: 2012,
      yearMax: 2019,
      because: `With a $${budgetUsd.toLocaleString("en-US")} budget, the guidance table uses a mid-2010s band. The budget itself is a hard cap.`,
    };
  }
  if (budgetUsd < 30_000) return { yearMin: 2015, yearMax: Math.min(2022, cap), because: "Under $30,000, the guidance table uses a newer band." };
  return { yearMin: 2018, yearMax: cap, because: "At $30,000 or more, the guidance table starts near the current model years." };
}
