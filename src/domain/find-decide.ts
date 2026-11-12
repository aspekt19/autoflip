/**
 * C3 Find decide + C4 challenge validation, and published confidence = min(C3, C4, guardrails).
 */

import {
  moreConservativeConfidence,
  type AgentVerdictConfidence,
} from "./agent-verdict-schema";
import { capConfidenceForHonesty } from "./confidence-cap";
import { capConfidenceForStopFlags } from "./nhtsa-stop-flags";
import {
  asFiniteNumber,
  asTrimmedString,
  normalizeEnum,
} from "./serv-json";

export const FIND_DECIDE_ACTIONS = ["buy", "negotiate", "inspect_first", "pass"] as const;
export type FindDecideAction = (typeof FIND_DECIDE_ACTIONS)[number];

export const FIND_DECIDE_CONFIDENCE = ["high", "medium", "low"] as const;
export type FindDecideConfidence = (typeof FIND_DECIDE_CONFIDENCE)[number];

/** Outbound / schema aliases that map onto FindDecideAction. */
const FIND_DECIDE_ACTION_ALIASES: Record<string, FindDecideAction> = {
  buy: "buy",
  negotiate: "negotiate",
  inspect_first: "inspect_first",
  needs_inspection: "inspect_first",
  pass: "pass",
};

export type FindDecideCitedLine = {
  text: string;
  evidenceIds: string[];
};

export type FindDecideAlternative = {
  key: string;
  whyNot: string;
};

export type FindDecide = {
  pickKey: string;
  action: FindDecideAction;
  confidence: FindDecideConfidence;
  confidenceWhy: string;
  reasons: FindDecideCitedLine[];
  watchOuts: FindDecideCitedLine[];
  askSeller: string[];
  alternatives: FindDecideAlternative[];
  offerUsd: number | null;
};

export type FindChallengeIssueKind =
  | "wrong_pick"
  | "overconfident"
  | "missed_risk"
  | "unsupported_claim";

export type FindChallengeIssue = {
  kind: FindChallengeIssueKind;
  text: string;
  evidenceIds: string[];
};

export type FindChallengeRevised = {
  pickKey: string | null;
  action: FindDecideAction | null;
  confidence: FindDecideConfidence | null;
};

export type FindChallenge = {
  agree: boolean;
  issues: FindChallengeIssue[];
  revised: FindChallengeRevised;
};

export type FindDecideIssue = { field: string; message: string };

export type ValidateFindDecideResult =
  | { ok: true; decide: FindDecide; dropped: string[] }
  | { ok: false; issues: FindDecideIssue[] };

export type ValidateFindChallengeResult =
  | { ok: true; challenge: FindChallenge; dropped: string[] }
  | { ok: false; issues: FindDecideIssue[] };

export type FindDecideShortlistMeta = {
  key: string;
  vin?: string | null;
  year?: number;
  make?: string;
  model?: string;
};

export type ValidateFindDecideContext = {
  shortlistKeys: ReadonlySet<string> | readonly string[];
  allowedEvidenceIds: ReadonlySet<string> | readonly string[];
  /** Ask price for the pick — offerUsd must be ≤ ask when set. */
  askUsd?: number | null;
  /** Fair-value band for offerUsd (optional). */
  fairValueUsd?: number | null;
  fairValueLowUsd?: number | null;
  fairValueHighUsd?: number | null;
  /** Optional shortlist rows for VIN / index pickKey resolution. */
  shortlist?: readonly FindDecideShortlistMeta[];
};

export type ValidateFindChallengeContext = {
  shortlistKeys: ReadonlySet<string> | readonly string[];
  allowedEvidenceIds: ReadonlySet<string> | readonly string[];
  /** Optional shortlist rows for VIN / index pickKey resolution. */
  shortlist?: readonly FindDecideShortlistMeta[];
};

export type PublishFindConfidenceInput = {
  c3: FindDecideConfidence;
  /** C4 revised.confidence when the challenge disagreed with a valid revision. */
  c4Revised?: FindDecideConfidence | null;
  action: FindDecideAction;
  /** Stop-level park-it / park-outside on the pick. */
  hasStopRecall?: boolean;
  /** Recall rows missing for the pick MMY. */
  recallsUnavailable?: boolean;
  /** Comparable count used for the price claim. */
  compCount?: number | null;
  /** Fair value for the pick. Missing fair value stays Medium when a second check ran. */
  fairValueUsd?: number | null;
  evidenceSettled?: boolean;
  /** True when the second check did not run. That, not a missing price comparison, forces Low. */
  secondCheckMissed?: boolean;
};

export const MISSING_PRICE_COMPARISON_SENTENCE =
  "We could not compare this asking price with enough similar cars, so confidence stays Medium.";

export type PublishFindConfidenceResult = {
  confidence: FindDecideConfidence;
  action: FindDecideAction;
  capped: boolean;
  reasons: string[];
};

const ISSUE_KINDS = ["wrong_pick", "overconfident", "missed_risk", "unsupported_claim"] as const;

const ACTION_RANK: Record<FindDecideAction, number> = {
  pass: 3,
  inspect_first: 2,
  negotiate: 1,
  buy: 0,
};

function asSet(input: ReadonlySet<string> | readonly string[]): Set<string> {
  return input instanceof Set ? new Set(input) : new Set(input);
}

function orderedShortlistKeys(
  shortlistKeys: ReadonlySet<string> | readonly string[],
  meta?: readonly FindDecideShortlistMeta[],
): string[] {
  if (meta?.length) {
    const fromMeta = meta.map((row) => row.key.trim()).filter(Boolean);
    if (fromMeta.length) return fromMeta;
  }
  return shortlistKeys instanceof Set ? [...shortlistKeys] : [...shortlistKeys];
}

function stripPickPrefix(raw: string): string {
  return raw.replace(/^(car|vin|key|id)\s*:\s*/i, "").trim();
}

/**
 * Resolve a SERV pickKey onto a shortlist key.
 * Exact, case-insensitive, car:/vin: prefix strip, VIN match, or unambiguous index.
 */
export function resolveShortlistPickKey(
  raw: unknown,
  shortlistKeys: ReadonlySet<string> | readonly string[],
  meta?: readonly FindDecideShortlistMeta[],
): string | null {
  const text = asTrimmedString(raw);
  if (!text) return null;
  const keys = orderedShortlistKeys(shortlistKeys, meta);
  const keySet = new Set(keys);
  if (keySet.has(text)) return text;

  const lower = text.toLowerCase();
  for (const key of keys) {
    if (key.toLowerCase() === lower) return key;
  }

  const stripped = stripPickPrefix(text);
  if (stripped && keySet.has(stripped)) return stripped;
  if (stripped) {
    const strippedLower = stripped.toLowerCase();
    for (const key of keys) {
      if (key.toLowerCase() === strippedLower) return key;
    }
  }

  const vinNeedle = stripped.toUpperCase();
  if (vinNeedle && meta?.length) {
    const vinHits = meta.filter(
      (row) => typeof row.vin === "string" && row.vin.trim().toUpperCase() === vinNeedle,
    );
    if (vinHits.length === 1 && keySet.has(vinHits[0]!.key)) return vinHits[0]!.key;
  }
  // Bare VIN sometimes equals the shortlist key itself.
  if (vinNeedle) {
    for (const key of keys) {
      if (key.toUpperCase() === vinNeedle) return key;
      if (stripPickPrefix(key).toUpperCase() === vinNeedle) return key;
    }
  }

  if (keys.length === 0) return null;
  const indexToken = stripped.toLowerCase();
  let index: number | null = null;
  if (indexToken === "first" || indexToken === "#1" || indexToken === "1st") index = 0;
  else {
    const hash = indexToken.match(/^#(\d+)$/);
    const plain = indexToken.match(/^(\d+)$/);
    const n = hash ? Number(hash[1]) : plain ? Number(plain[1]) : NaN;
    if (Number.isFinite(n) && n >= 0) {
      // 1-based when 1..N; 0-based only when the token is "0".
      if (n === 0) index = 0;
      else if (n >= 1 && n <= keys.length) index = n - 1;
    }
  }
  if (index != null && index >= 0 && index < keys.length) return keys[index]!;

  return null;
}

function normalizeDecideAction(raw: unknown): FindDecideAction | null {
  const text = asTrimmedString(raw);
  if (!text) return null;
  const lower = text.toLowerCase().replace(/\s+/g, "_");
  if (lower in FIND_DECIDE_ACTION_ALIASES) return FIND_DECIDE_ACTION_ALIASES[lower]!;
  return normalizeEnum(lower, FIND_DECIDE_ACTIONS);
}

function filterEvidenceIds(claimed: unknown, allowed: Set<string>, dropped: string[], field: string): string[] {
  if (!Array.isArray(claimed)) return [];
  const out: string[] = [];
  for (const raw of claimed) {
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (!id) continue;
    if (!allowed.has(id)) {
      dropped.push(`${field}:${id}`);
      continue;
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function readCitedLines(
  raw: unknown,
  allowed: Set<string>,
  dropped: string[],
  field: string,
  softEvidenceId?: string,
): FindDecideCitedLine[] {
  if (!Array.isArray(raw)) return [];
  const out: FindDecideCitedLine[] = [];
  for (const [index, item] of raw.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const text = typeof row.text === "string" ? row.text.trim().slice(0, 400) : "";
    if (!text) {
      dropped.push(`${field}[${index}].text`);
      continue;
    }
    let evidenceIds = filterEvidenceIds(row.evidenceIds, allowed, dropped, `${field}[${index}].evidenceIds`);
    // Soft-attach the pick car evidence rather than dropping every reason.
    if (evidenceIds.length === 0 && softEvidenceId && allowed.has(softEvidenceId)) {
      evidenceIds = [softEvidenceId];
      dropped.push(`${field}[${index}].evidenceIds:soft_attached`);
    } else if (evidenceIds.length === 0) {
      dropped.push(`${field}[${index}].evidenceIds`);
      continue;
    }
    out.push({ text, evidenceIds });
  }
  return out;
}

/**
 * Validate and sanitize a raw find_decide payload.
 * pickKey / alternatives must be in the shortlist; unsupported cited lines are dropped.
 */
export function validateFindDecide(
  input: unknown,
  ctx: ValidateFindDecideContext,
): ValidateFindDecideResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, issues: [{ field: "decide", message: "find_decide must be an object." }] };
  }
  const raw = input as Record<string, unknown>;
  const shortlist = asSet(ctx.shortlistKeys);
  const allowed = asSet(ctx.allowedEvidenceIds);
  const dropped: string[] = [];

  const pickKey = resolveShortlistPickKey(raw.pickKey, ctx.shortlistKeys, ctx.shortlist);
  if (!pickKey || !shortlist.has(pickKey)) {
    return {
      ok: false,
      issues: [{ field: "pickKey", message: "find_decide.pickKey must be a shortlist key." }],
    };
  }

  const action = normalizeDecideAction(raw.action);
  if (!action) {
    return {
      ok: false,
      issues: [{ field: "action", message: "find_decide.action must be buy|negotiate|inspect_first|pass." }],
    };
  }

  const confidence = normalizeEnum(raw.confidence, FIND_DECIDE_CONFIDENCE);
  if (!confidence) {
    return {
      ok: false,
      issues: [{ field: "confidence", message: "find_decide.confidence must be high|medium|low." }],
    };
  }

  const confidenceWhy =
    typeof raw.confidenceWhy === "string" ? raw.confidenceWhy.trim().slice(0, 280) : "";
  const softCarEvidence = `car:${pickKey}`;
  const reasons = readCitedLines(raw.reasons, allowed, dropped, "reasons", softCarEvidence);
  const watchOuts = readCitedLines(raw.watchOuts, allowed, dropped, "watchOuts", softCarEvidence);

  const askSeller: string[] = [];
  if (Array.isArray(raw.askSeller)) {
    for (const item of raw.askSeller) {
      if (typeof item !== "string") continue;
      const text = item.trim().slice(0, 200);
      if (text) askSeller.push(text);
    }
  }

  const alternatives: FindDecideAlternative[] = [];
  if (Array.isArray(raw.alternatives)) {
    for (const [index, item] of raw.alternatives.entries()) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const row = item as Record<string, unknown>;
      const key = resolveShortlistPickKey(row.key, ctx.shortlistKeys, ctx.shortlist);
      if (!key || !shortlist.has(key) || key === pickKey) {
        dropped.push(`alternatives[${index}].key`);
        continue;
      }
      if (alternatives.some((alt) => alt.key === key)) continue;
      const whyNot = typeof row.whyNot === "string" ? row.whyNot.trim().slice(0, 280) : "";
      alternatives.push({ key, whyNot: whyNot || "Not the pick." });
    }
  }

  const offerRaw = asFiniteNumber(raw.offerUsd);
  let offerUsd: number | null = offerRaw != null ? Math.round(offerRaw) : null;
  if (offerUsd != null) {
    const ask = ctx.askUsd;
    if (typeof ask === "number" && Number.isFinite(ask) && offerUsd > ask) {
      dropped.push("offerUsd>ask");
      offerUsd = null;
    }
    const low = ctx.fairValueLowUsd ?? ctx.fairValueUsd;
    const high = ctx.fairValueHighUsd ?? ctx.fairValueUsd;
    if (
      offerUsd != null &&
      typeof low === "number" &&
      typeof high === "number" &&
      Number.isFinite(low) &&
      Number.isFinite(high) &&
      (offerUsd < low * 0.85 || offerUsd > high * 1.05)
    ) {
      dropped.push("offerUsd_out_of_fair_band");
      offerUsd = null;
    }
    if (action !== "negotiate" && action !== "buy") {
      dropped.push("offerUsd_without_buy_or_negotiate");
      offerUsd = null;
    }
  }

  return {
    ok: true,
    decide: {
      pickKey,
      action,
      confidence,
      confidenceWhy: confidenceWhy || "Confidence from SERV find_decide.",
      reasons,
      watchOuts,
      askSeller,
      alternatives,
      offerUsd,
    },
    dropped,
  };
}

/**
 * Validate and sanitize a raw find_challenge payload.
 * Invalid revised fields are nulled; invented evidence ids are dropped.
 */
export function validateFindChallenge(
  input: unknown,
  ctx: ValidateFindChallengeContext,
): ValidateFindChallengeResult {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, issues: [{ field: "challenge", message: "find_challenge must be an object." }] };
  }
  const raw = input as Record<string, unknown>;
  const shortlist = asSet(ctx.shortlistKeys);
  const allowed = asSet(ctx.allowedEvidenceIds);
  const dropped: string[] = [];

  if (typeof raw.agree !== "boolean") {
    return { ok: false, issues: [{ field: "agree", message: "find_challenge.agree must be boolean." }] };
  }
  const agree = raw.agree;

  const issues: FindChallengeIssue[] = [];
  if (Array.isArray(raw.issues)) {
    for (const [index, item] of raw.issues.entries()) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const row = item as Record<string, unknown>;
      const kind = normalizeEnum(row.kind, ISSUE_KINDS);
      if (!kind) {
        dropped.push(`issues[${index}].kind`);
        continue;
      }
      const text = typeof row.text === "string" ? row.text.trim().slice(0, 400) : "";
      if (!text) {
        dropped.push(`issues[${index}].text`);
        continue;
      }
      const evidenceIds = filterEvidenceIds(row.evidenceIds, allowed, dropped, `issues[${index}].evidenceIds`);
      if (evidenceIds.length === 0) {
        dropped.push(`issues[${index}].evidenceIds`);
        continue;
      }
      issues.push({ kind, text, evidenceIds });
    }
  }

  const revisedRaw =
    raw.revised && typeof raw.revised === "object" && !Array.isArray(raw.revised)
      ? (raw.revised as Record<string, unknown>)
      : {};

  let pickKey: string | null = resolveShortlistPickKey(
    revisedRaw.pickKey,
    ctx.shortlistKeys,
    ctx.shortlist,
  );
  if (asTrimmedString(revisedRaw.pickKey) && (!pickKey || !shortlist.has(pickKey))) {
    dropped.push("revised.pickKey");
    pickKey = null;
  } else if (pickKey && !shortlist.has(pickKey)) {
    dropped.push("revised.pickKey");
    pickKey = null;
  }

  let action = normalizeDecideAction(revisedRaw.action);
  if (asTrimmedString(revisedRaw.action) && !action) {
    dropped.push("revised.action");
  }

  let confidence = normalizeEnum(revisedRaw.confidence, FIND_DECIDE_CONFIDENCE);
  if (asTrimmedString(revisedRaw.confidence) && !confidence) {
    dropped.push("revised.confidence");
  }

  // Agreeing challenges should not silently revise the pick.
  if (agree) {
    if (pickKey || action || confidence) dropped.push("revised_while_agree");
    pickKey = null;
    action = null;
    confidence = null;
  }

  return {
    ok: true,
    challenge: {
      agree,
      issues,
      revised: { pickKey, action, confidence },
    },
    dropped,
  };
}

function clampActionForStop(action: FindDecideAction, hasStop: boolean): FindDecideAction {
  if (!hasStop) return action;
  if (ACTION_RANK[action] < ACTION_RANK.inspect_first) return "inspect_first";
  return action;
}

/**
 * Published confidence = min(C3, C4 revised, guardrail caps).
 * Stop-level recall also clamps action to at most inspect_first.
 */
export function publishFindDecideConfidence(
  input: PublishFindConfidenceInput,
): PublishFindConfidenceResult {
  const reasons: string[] = [];
  let confidence: FindDecideConfidence = input.c3;
  let action = input.action;

  if (input.c4Revised) {
    const merged = moreConservativeConfidence(
      confidence as AgentVerdictConfidence,
      input.c4Revised as AgentVerdictConfidence,
    );
    if (merged && merged !== confidence) {
      reasons.push(`Lowered to ${merged}: C4 revised confidence was more conservative than C3.`);
      confidence = merged as FindDecideConfidence;
    }
  }

  const beforeStop = confidence;
  confidence = capConfidenceForStopFlags(confidence, Boolean(input.hasStopRecall)) as FindDecideConfidence;
  if (confidence !== beforeStop) {
    reasons.push("Lowered from High: stop-level NHTSA park-it or park-outside guidance is open.");
  }
  const clampedAction = clampActionForStop(action, Boolean(input.hasStopRecall));
  if (clampedAction !== action) {
    reasons.push("Action capped at inspect_first: stop-level recall is open on the pick.");
    action = clampedAction;
  }

  if (input.recallsUnavailable && confidence === "high") {
    confidence = "medium";
    reasons.push("Lowered from High: recall data unavailable for the pick.");
  }

  const comps = input.compCount;
  if (typeof comps === "number" && Number.isFinite(comps) && comps < 3 && confidence === "high") {
    confidence = "medium";
    reasons.push("Lowered from High: fewer than 3 similar listings (limited comparison).");
  }

  // Missing fair value is common (thin same-model comps). It is uncertainty, not a failed review.
  // Low is reserved for a missed second check or a stop-level risk already applied above.
  if (
    "fairValueUsd" in input &&
    (input.fairValueUsd == null ||
      (typeof input.fairValueUsd === "number" && !Number.isFinite(input.fairValueUsd)))
  ) {
    if (input.secondCheckMissed) {
      if (confidence !== "low") {
        reasons.push("A second check did not run, so confidence is Low.");
        confidence = "low";
      }
    } else if (confidence !== "medium") {
      reasons.push(MISSING_PRICE_COMPARISON_SENTENCE);
      confidence = "medium";
    } else {
      reasons.push(MISSING_PRICE_COMPARISON_SENTENCE);
    }
  }

  const honesty = capConfidenceForHonesty({
    confidence,
    verdict: action,
    evidenceSettled: input.evidenceSettled,
    rankingMayChange: input.evidenceSettled === false,
  });
  if (honesty.capped && honesty.reason) {
    confidence = honesty.confidence as FindDecideConfidence;
    reasons.push(honesty.reason);
  }

  return {
    confidence,
    action,
    capped: reasons.length > 0,
    reasons,
  };
}

/** Merge C3 decide with a valid C4 challenge revision. */
export function applyFindChallengeRevision(
  decide: FindDecide,
  challenge: FindChallenge,
): FindDecide {
  if (challenge.agree) return decide;
  return {
    ...decide,
    pickKey: challenge.revised.pickKey ?? decide.pickKey,
    action: challenge.revised.action ?? decide.action,
    confidence: challenge.revised.confidence ?? decide.confidence,
  };
}
