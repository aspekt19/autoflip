/**
 * SERV submit_brief payload + budget quote check.
 * Code does not parse shopper chat into fields — SERV extracts; quote check is structural.
 */

export type ShopperBriefBudget = {
  maxUsd: number | null;
  /** Verbatim shopper words that stated the budget — must appear in the chat transcript. */
  userQuote: string | null;
};

/** Structured constraint row SERV may emit on submit_brief (no chat parsing). */
export type ShopperBriefConstraint = {
  key: string;
  value: string;
};

export type ShopperBrief = {
  summary: string;
  budget: ShopperBriefBudget;
  zip: string | null;
  radiusMi: number | null;
  notes: string | null;
  /** Hard constraints SERV already structured on submit_brief. */
  hardConstraints?: ShopperBriefConstraint[];
  /** Soft / preference constraints SERV already structured on submit_brief. */
  softConstraints?: ShopperBriefConstraint[];
  /** Relaxations the shopper already agreed to (from SERV, not code inference). */
  agreedRelaxations?: ShopperBriefConstraint[];
};

export type BudgetQuoteCheckStatus = "valid" | "null" | "fabricated" | "mismatch";

export type BudgetQuoteCheck =
  | { ok: true; status: "valid" | "null" }
  | { ok: false; status: "fabricated" | "mismatch"; message: string };

/** Content-agnostic chat abuse limits (not topic classification). */
export const SERV_CHAT_MAX_MESSAGE_CHARS = 4_000;
export const SERV_CHAT_MAX_USER_TURNS = 40;

export const SERV_TOPIC_SCOPE_RULE =
  "Lemonless car scope only: finding, buying, flipping, or checking used cars and related dealer inventory. If the shopper asks about anything outside that scope, politely decline in chat, do not call tools, and do not call submit_brief.";

export function checkBudgetUserQuote(
  budget: ShopperBriefBudget,
  transcript: string,
): BudgetQuoteCheck {
  const maxUsd = budget.maxUsd;
  const quote = typeof budget.userQuote === "string" ? budget.userQuote.trim() : "";
  if ((maxUsd == null || !Number.isFinite(maxUsd)) && !quote) {
    return { ok: true, status: "null" };
  }
  if (!quote) {
    return {
      ok: false,
      status: "fabricated",
      message: "budget.userQuote is required when budget.maxUsd is set — quote the shopper's words.",
    };
  }
  if (!transcript.includes(quote)) {
    return {
      ok: false,
      status: "fabricated",
      message: "budget.userQuote must be verbatim text from the shopper chat transcript.",
    };
  }
  if (maxUsd == null || !Number.isFinite(maxUsd)) {
    return { ok: true, status: "valid" };
  }
  const digits = String(Math.round(maxUsd));
  const quoteDigits = quote.replace(/[^\d]/g, "");
  if (!quoteDigits.includes(digits) && !digitsIncludesLoose(quote, Math.round(maxUsd))) {
    return {
      ok: false,
      status: "mismatch",
      message: `budget.maxUsd ${digits} does not match numbers in budget.userQuote.`,
    };
  }
  return { ok: true, status: "valid" };
}

/** Accept "$15k" / "15,000" / "15k" style quotes for a dollar ceiling. */
function digitsIncludesLoose(quote: string, maxUsd: number): boolean {
  const lower = quote.toLowerCase();
  if (maxUsd >= 1000 && maxUsd % 1000 === 0) {
    const k = String(maxUsd / 1000);
    if (new RegExp(`\\b${k}\\s*k\\b`).test(lower)) return true;
  }
  const withCommas = maxUsd.toLocaleString("en-US");
  if (quote.includes(withCommas) || quote.includes(String(maxUsd))) return true;
  return false;
}

export function parseShopperBrief(raw: unknown):
  | { ok: true; brief: ShopperBrief }
  | { ok: false; issues: Array<{ field: string; message: string }> } {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, issues: [{ field: "args", message: "submit_brief args must be an object." }] };
  }
  const row = raw as Record<string, unknown>;
  const issues: Array<{ field: string; message: string }> = [];
  const summary = typeof row.summary === "string" ? row.summary.trim().slice(0, 400) : "";
  if (!summary) issues.push({ field: "summary", message: "summary is required." });

  const budgetRaw =
    row.budget && typeof row.budget === "object" && !Array.isArray(row.budget)
      ? (row.budget as Record<string, unknown>)
      : null;
  if (!budgetRaw) {
    issues.push({ field: "budget", message: "budget { maxUsd, userQuote } is required." });
  }
  let maxUsd: number | null = null;
  if (budgetRaw && budgetRaw.maxUsd != null && budgetRaw.maxUsd !== "") {
    const n = typeof budgetRaw.maxUsd === "number" ? budgetRaw.maxUsd : Number(budgetRaw.maxUsd);
    if (!Number.isFinite(n) || n < 1000 || n > 500_000) {
      issues.push({ field: "budget.maxUsd", message: "budget.maxUsd must be a dollar amount or null." });
    } else {
      maxUsd = Math.round(n);
    }
  }
  const userQuote =
    budgetRaw && typeof budgetRaw.userQuote === "string" ? budgetRaw.userQuote.trim().slice(0, 200) : null;

  let zip: string | null = null;
  if (row.zip != null && row.zip !== "") {
    const z = String(row.zip).trim();
    if (!/^\d{5}$/.test(z)) issues.push({ field: "zip", message: "zip must be a 5-digit US ZIP or null." });
    else zip = z;
  }
  let radiusMi: number | null = null;
  if (row.radiusMi != null && row.radiusMi !== "") {
    const n = typeof row.radiusMi === "number" ? row.radiusMi : Number(row.radiusMi);
    if (!Number.isFinite(n) || n < 1 || n > 3000) {
      issues.push({ field: "radiusMi", message: "radiusMi must be miles or null for nationwide." });
    } else radiusMi = Math.round(n);
  } else if (row.radiusMi === null) {
    radiusMi = null;
  }
  const notes = typeof row.notes === "string" ? row.notes.trim().slice(0, 400) || null : null;
  const hardConstraints = parseBriefConstraintList(row.hardConstraints);
  const softConstraints = parseBriefConstraintList(row.softConstraints);
  const agreedRelaxations = parseBriefConstraintList(row.agreedRelaxations);
  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    brief: {
      summary,
      budget: { maxUsd, userQuote: userQuote || null },
      zip,
      radiusMi,
      notes,
      ...(hardConstraints.length ? { hardConstraints } : {}),
      ...(softConstraints.length ? { softConstraints } : {}),
      ...(agreedRelaxations.length ? { agreedRelaxations } : {}),
    },
  };
}

function parseBriefConstraintList(raw: unknown): ShopperBriefConstraint[] {
  if (!Array.isArray(raw)) return [];
  const out: ShopperBriefConstraint[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const key = typeof row.key === "string" ? row.key.trim().slice(0, 80) : "";
    const value = typeof row.value === "string" ? row.value.trim().slice(0, 200) : "";
    if (key && value) out.push({ key, value });
  }
  return out.slice(0, 24);
}

export function formatShopperBriefCard(brief: ShopperBrief): string {
  const lines = [brief.summary];
  if (brief.budget.maxUsd != null) {
    const q = brief.budget.userQuote ? ` (“${brief.budget.userQuote}”)` : "";
    lines.push(`Budget: $${brief.budget.maxUsd.toLocaleString("en-US")}${q}`);
  } else if (brief.budget.userQuote) {
    lines.push(`Budget: ${brief.budget.userQuote}`);
  }
  if (brief.zip) {
    const r = brief.radiusMi != null ? ` · ${brief.radiusMi} mi` : " · nationwide OK";
    lines.push(`Location: ${brief.zip}${r}`);
  } else if (brief.radiusMi != null) {
    lines.push(`Radius: ${brief.radiusMi} mi`);
  }
  if (brief.hardConstraints?.length) {
    lines.push(
      `Hard: ${brief.hardConstraints.map((c) => `${c.key}=${c.value}`).join("; ")}`,
    );
  }
  if (brief.softConstraints?.length) {
    lines.push(
      `Soft: ${brief.softConstraints.map((c) => `${c.key}=${c.value}`).join("; ")}`,
    );
  }
  if (brief.agreedRelaxations?.length) {
    lines.push(
      `Agreed relaxations: ${brief.agreedRelaxations.map((c) => `${c.key}=${c.value}`).join("; ")}`,
    );
  }
  if (brief.notes) lines.push(brief.notes);
  return lines.join("\n");
}

export function countUserTurns(messages: ReadonlyArray<{ role: string }>): number {
  let n = 0;
  for (const row of messages) {
    if (row.role === "user") n += 1;
  }
  return n;
}

export function chatLimitViolation(input: {
  message: string | null | undefined;
  messages: ReadonlyArray<{ role: string }>;
  addingUserMessage: boolean;
}): { ok: true } | { ok: false; message: string } {
  const text = typeof input.message === "string" ? input.message : "";
  if (text.length > SERV_CHAT_MAX_MESSAGE_CHARS) {
    return {
      ok: false,
      message: `That message is too long (max ${SERV_CHAT_MAX_MESSAGE_CHARS} characters). Shorten it and try again.`,
    };
  }
  const turns = countUserTurns(input.messages) + (input.addingUserMessage && text.trim() ? 1 : 0);
  if (turns > SERV_CHAT_MAX_USER_TURNS) {
    return {
      ok: false,
      message: `This chat hit the turn limit (${SERV_CHAT_MAX_USER_TURNS}). Start a new chat to continue.`,
    };
  }
  return { ok: true };
}
