/**
 * Buyer-facing copy for the "How this decision was made" journal.
 * Main view: one or two plain sentences. No snake_case step ids, bracketed tags,
 * model suffixes, response ids, digests, JSON, or internal abbreviations.
 */

import { plainDecisionAction } from "./find-buyer-copy";
import { buyerSafeResaleJournalText } from "./resale-journal-copy";
import type {
  ServDecisionJournalView,
  ServDecisionOrigin,
  ServDecisionStep,
  ServSecondCheckSummary,
} from "./serv-decision-step";

/** Snake_case tokens and [bracketed] tags must not appear in the main journal view. */
const SNAKE_CASE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/;
const BRACKETED_TAG = /\[[^\]]+\]/;

/**
 * Internal abbreviations / jargon banned from journal main text.
 * Prefer plain wording: "government recall database", "similar cars for sale nearby",
 * "the car's factory details", "postal code", etc.
 */
export const JOURNAL_BANNED_JARGON: RegExp[] = [
  /\bNHTSA\b/i,
  /\bvPIC\b/i,
  /\bVIN\s*decode\b/i,
  /\bDecodeVinValues\b/i,
  /\bcomps?\b/i,
  /\bcomparables?\b/i,
  /\bTCO\b/,
  /\bMSRP\b/i,
  /\bZIPS?\b/i,
  /\bAPIs?\b/,
  /\bLLMs?\b/i,
  /\bMMY\b/,
  /\bJSON\b/i,
  /\bTypeScript\b/i,
  /\bchatcmpl-/i,
  /\bresponse id\b/i,
  /\binputs digest\b/i,
  /\bschemaVersion\b/i,
  /\brawResponse\b/i,
  /\ballowlist(?:ed)?\b/i,
  /\bparkIt\b/i,
  /\bNCAP\b/i,
  /\bUSD\b/,
  /\bP&L\b/i,
  /\bPnL\b/i,
];

export function journalMainTextViolations(text: string): string[] {
  const hits: string[] = [];
  const snake = text.match(SNAKE_CASE);
  if (snake) hits.push(snake[0]!);
  const bracket = text.match(BRACKETED_TAG);
  if (bracket) hits.push(bracket[0]!);
  for (const re of JOURNAL_BANNED_JARGON) {
    const m = text.match(re);
    if (m) hits.push(m[0]!);
  }
  return hits;
}

function scrubBuyerText(text: string): string {
  return buyerSafeResaleJournalText(
    text
      .replace(/\binputs digest\s+[a-f0-9]+…?/gi, "")
      .replace(/\bchatcmpl-[A-Za-z0-9_-]+/g, "")
      .replace(/\bresponse\s+[A-Za-z0-9_-]+/gi, "")
      .replace(/\bmodel\s+[A-Za-z0-9._-]+/gi, "")
      .replace(/\b(verdict_decide|verdict_challenge|need_extract|need_guard|find_next_check|find_pick|find_triage|find_decide|find_challenge|facts_given|resale_[a-z_]+|radar_[a-z_]+)\b/gi, "")
      .replace(/\bNHTSA\b/gi, "government recall database")
      .replace(/\bvPIC\b/gi, "the car's factory details")
      .replace(/\bVIN\s*decode(?:r|d|ing)?\b/gi, "the car's factory details")
      .replace(/\bDecodeVinValues\b/gi, "the car's factory details")
      .replace(/\bcomparables?\b/gi, "similar cars for sale nearby")
      .replace(/\bcomps?\b/gi, "similar cars for sale nearby")
      .replace(/\bTCO\b/g, "total cost to own")
      .replace(/\bMSRP\b/gi, "sticker price")
      .replace(/\bZIP\s*codes?\b/gi, "postal codes")
      .replace(/\bZIP\b/g, "postal code")
      .replace(/\bAPIs?\b/g, "data service")
      .replace(/\bLLMs?\b/gi, "language model")
      .replace(/\bMMY\b/g, "year, make, and model")
      .replace(/\bJSON\b/gi, "")
      .replace(/\bTypeScript\b/gi, "code")
      .replace(/\ballowlist(?:ed)?\b/gi, "approved")
      .replace(/\bparkIt\b/gi, "do-not-drive recall")
      .replace(/\bNCAP\b/gi, "crash-test rating")
      .replace(/\bP&L\b/gi, "profit figures")
      .replace(/\bPnL\b/gi, "profit figures")
      .replace(/\bUSD\b/g, "dollars")
      .replace(/\b(ok|failed|skipped|not_run)\b/gi, (m) => {
        if (/^ok$/i.test(m)) return "finished";
        if (/^failed$/i.test(m)) return "did not finish";
        if (/^skipped$/i.test(m)) return "was skipped";
        return "did not run";
      })
      .replace(/[_→·]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim(),
  );
}

function plainAction(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  const cleaned = value.trim().toLowerCase();
  if (cleaned === "buy" || cleaned === "good_deal") return "Buy";
  if (cleaned === "negotiate" || cleaned === "fair") return "Fair price";
  if (cleaned === "pass" || cleaned === "walk_away" || cleaned === "overpriced" || cleaned === "skip") {
    return "Skip";
  }
  if (cleaned === "needs_inspection" || cleaned === "insufficient_data") return "Needs inspection";
  if (cleaned === "withheld") return "hold the verdict";
  const plain = plainDecisionAction(value);
  return scrubBuyerText(plain) || null;
}

function extractActionFromOutput(output: string): string | null {
  const match = output.match(
    /\b(?:Decided|verdict|chose|chose\s+to)\s+(buy|negotiate|pass|needs_inspection|withheld|good_deal|fair|walk_away|overpriced)\b/i,
  );
  if (match) return plainAction(match[1]!);
  const bare = output.match(/\b(buy|negotiate|pass|needs_inspection)\b/i);
  return bare ? plainAction(bare[1]!) : null;
}

function extractClampActions(output: string): { from: string; to: string } | null {
  const match = output.match(
    /clamped\s+([a-z_?]+)\s*(?:→|->|to)\s*([a-z_?]+)/i,
  );
  if (!match) return null;
  const from = plainAction(match[1]!) ?? scrubBuyerText(match[1]!);
  const to = plainAction(match[2]!) ?? scrubBuyerText(match[2]!);
  if (!from || !to) return null;
  return { from, to };
}

/** Plain per-step marker: Decided by SERV vs Limited by safety rule. */
export function formatJournalOriginMarker(step: ServDecisionStep): string {
  if (step.origin === "rule_clamped" || step.origin === "rule_override") {
    const plain = scrubBuyerText(step.originReason ?? "safety rules limited this choice");
    const reason =
      plain && journalMainTextViolations(plain).length === 0
        ? plain.replace(/\.\s*$/, "")
        : "safety rules limited this choice";
    return `Limited by safety rule: ${reason}.`;
  }
  if (step.origin === "code" || step.by === "code") {
    return "";
  }
  return "";
}

/**
 * True when a clamped / overridden step is missing its buyer-facing safety label.
 * Used by tests so a clamp cannot ship unlabeled.
 */
export function clampMissingOriginLabel(step: ServDecisionStep): boolean {
  if (step.origin !== "rule_clamped" && step.origin !== "rule_override") return false;
  const marker = formatJournalOriginMarker(step);
  return !/^Limited by safety rule:/i.test(marker);
}

/**
 * One or two plain sentences for a journal step. Never includes step ids, models, or hashes.
 * Origin marker ("Decided by SERV" / "Limited by safety rule: …") is a separate line via
 * `formatJournalOriginMarker` so the narrative stays short.
 */
export function formatJournalStepSentences(step: ServDecisionStep): string {
  const who = step.by === "SERV" ? "SERV" : "Code";
  const action = extractActionFromOutput(step.output);
  const clamp = extractClampActions(step.output) ||
    (step.origin === "rule_clamped" || step.origin === "rule_override"
      ? (() => {
          const from = step.output.match(/clamped\s+([a-z_?]+)/i)?.[1];
          const to = step.output.match(/(?:→|->|to)\s*([a-z_?]+)/i)?.[1];
          if (!from || !to) return null;
          return {
            from: plainAction(from) ?? scrubBuyerText(from),
            to: plainAction(to) ?? scrubBuyerText(to),
          };
        })()
      : null);
  const reason = scrubBuyerText(step.output);

  const safeReason =
    reason &&
    reason.length > 0 &&
    !/^Decision recorded$/i.test(reason) &&
    !/^was skipped$/i.test(reason) &&
    journalMainTextViolations(reason).length === 0
      ? reason.replace(/\.\s*$/, "")
      : null;

  if (step.status === "not_run") {
    return `${who} did not run this step.${safeReason ? ` ${safeReason}.` : ""}`.replace(/\.\s*\./g, ".");
  }
  if (step.status === "skipped") {
    return `${who} skipped this step.${safeReason ? ` ${safeReason}.` : ""}`.replace(/\.\s*\./g, ".");
  }
  if (step.status === "failed") {
    return `${who} tried this step but it did not finish.${safeReason ? ` ${safeReason}.` : ""}`.replace(
      /\.\s*\./g,
      ".",
    );
  }

  switch (step.step) {
    case "need_guard":
      return "SERV screened your request before reading the details.";
    case "need_extract":
      return safeReason && safeReason.length > 12
        ? `SERV read your request and understood: ${safeReason.replace(/^Decided\s+/i, "")}.`
        : "SERV read your request and wrote down what you need.";
    case "find_next_check":
      return "SERV chose which check to run next from the approved list. Code ran that check and saved the results.";
    case "find_pick":
      return action
        ? `SERV reviewed the shortlist and leaned toward ${action}.`
        : "SERV reviewed the shortlist and named which car to look at first.";
    case "facts_given":
      return "Code gathered the public-record facts used for this decision.";
    case "find_triage":
      return "SERV shortlisted a few cars from the full pool for a closer look.";
    case "find_decide":
      if (clamp) {
        return `SERV reviewed the shortlist and suggested ${clamp.from}. Code safety rules changed that to ${clamp.to}.`;
      }
      return action
        ? `SERV reviewed the shortlist facts and chose ${action}.`
        : "SERV reviewed the shortlist facts and chose what you should do next.";
    case "find_challenge":
      return "A second independent SERV check reviewed that decision.";
    case "verdict_decide":
      if (clamp) {
        return `SERV reviewed the facts and suggested ${clamp.from}. Code safety rules changed that to ${clamp.to}.`;
      }
      return action
        ? `SERV reviewed the facts from code and chose ${action}.`
        : "SERV reviewed the facts from code and chose what you should do next.";
    case "verdict_challenge":
      return "A second independent SERV check reviewed the same facts.";
    case "resale_plan_search":
    case "plan_search":
      return "SERV planned how to search for a resale deal.";
    case "resale_triage":
    case "triage":
      return "SERV sorted which listings were worth a closer look.";
    case "resale_pick":
    case "pick":
      return "SERV picked a car from the shortlist that already passed the checks. Profit figures came from code.";
    case "resale_challenge":
    case "challenge":
      return "A second independent SERV check reviewed that pick.";
    case "deep_check":
      return step.by === "SERV"
        ? "SERV asked for a deeper look at one listing. Code supplied the numbers."
        : "Code ran a deeper check on one listing.";
    case "rank":
      return "Code ranked the cars by the recorded profit and risk figures.";
    case "reject":
      return safeReason
        ? `This listing was set aside. ${safeReason}.`
        : "This listing was set aside.";
    case "stop_or_widen":
      return "SERV decided whether to stop or widen the search.";
    case "fallback":
      return "SERV did not decide this step.";
    case "comps_verify":
    case "price_badge":
      return "Code calculated the asking price, fair value, and similar cars for sale nearby.";
    case "free_gov_recalls":
      return "Code checked the government recall database for this car.";
    case "free_gov_vpic":
      return "Code looked up the car's factory details.";
    case "gates":
    case "report_gates":
      return "Code checked safety rules before publishing the answer.";
    default: {
      if (step.by === "code") {
        const cleaned = reason && reason.length > 8 ? scrubBuyerText(reason) : "";
        if (cleaned && journalMainTextViolations(cleaned).length === 0) {
          return `Code verified this part. ${cleaned.replace(/\.\s*$/, "")}.`;
        }
        return "Code verified the numbers for this step.";
      }
      if (clamp) {
        return `SERV suggested ${clamp.from}. Code safety rules changed that to ${clamp.to}.`;
      }
      if (action) {
        return `SERV reviewed the facts and chose ${action}.`;
      }
      if (reason && reason.length > 8 && !/Decision recorded/i.test(reason)) {
        const cleaned = scrubBuyerText(reason);
        if (journalMainTextViolations(cleaned).length === 0) {
          // Don't prepend/lowercase when the text already starts with SERV/Code.
          if (/^(SERV|Code)\b/i.test(cleaned)) {
            return cleaned.replace(/\.\s*$/, "") + ".";
          }
          return `${who} ${cleaned.charAt(0).toLowerCase()}${cleaned.slice(1)}`.replace(/\.\s*$/, "") + ".";
        }
      }
      return step.by === "SERV"
        ? "SERV reviewed the recorded facts and made a choice under the safety rules."
        : "Code verified the recorded facts for this step.";
    }
  }
}

export function formatJournalSecondCheckSentences(second: ServSecondCheckSummary): string {
  if (second.answersAgree === true) {
    return "A second independent SERV check agreed.";
  }
  if (second.answersAgree === false) {
    const objection = scrubBuyerText(second.detail)
      .replace(/^The two answers did not agree\.?\s*/i, "")
      .replace(/\bConfidence dropped from \w+ to \w+\.?/gi, "")
      .replace(/\bConfidence is shown as lower because the answers did not agree\.?/gi, "")
      .trim();
    const base =
      "A second independent SERV check disagreed, so confidence is lower.";
    return objection && journalMainTextViolations(objection).length === 0
      ? `${base} ${objection.replace(/\.\s*$/, "")}.`
      : base;
  }
  if (second.status === "missing" || second.status === "not_run") {
    return "A second independent SERV check did not run for this report.";
  }
  if (second.status === "skipped_no_budget" || second.status === "skipped_no_key") {
    return "A second independent SERV check was skipped.";
  }
  if (second.status === "unavailable") {
    return "A second independent SERV check did not finish.";
  }
  if (second.status === "ignored_malformed" || second.status === "ignored_no_evidence") {
    return "A second independent SERV check returned nothing usable and was ignored.";
  }
  return "A second independent SERV check did not run for this report.";
}

export type JournalStepView = {
  sentences: string;
  originMarker: string;
  origin: ServDecisionOrigin;
  by: ServDecisionStep["by"];
  /** Real response id / model / timestamp when recorded — shown under the plain sentences. */
  provenance: {
    modelId: string | null;
    runId: string | null;
    timestamp: string | null;
  };
  tech: {
    step: string;
    status: string;
    modelId: string | null;
    runId: string | null;
    timestamp: string | null;
    latencyMs: number | null;
    costUsd: number | null;
    inputSummary: string;
    output: string;
    origin: ServDecisionOrigin;
    originReason: string | null;
  };
};

export function journalStepViews(steps: readonly ServDecisionStep[]): JournalStepView[] {
  return steps.map((step) => ({
    sentences: formatJournalStepSentences(step),
    originMarker: formatJournalOriginMarker(step),
    origin: step.origin,
    by: step.by,
    provenance: {
      modelId: step.modelId,
      runId: step.runId,
      timestamp: step.timestamp,
    },
    tech: {
      step: step.step,
      status: step.status,
      modelId: step.modelId,
      runId: step.runId,
      timestamp: step.timestamp,
      latencyMs: step.latencyMs,
      costUsd: step.costUsd,
      inputSummary: step.inputSummary,
      output: step.output,
      origin: step.origin,
      originReason: step.originReason,
    },
  }));
}

/** Shared intro shown above the step list — must stay jargon-free. */
export const JOURNAL_INTRO =
  "Dollar amounts and scores come from code. SERV may choose an action and explain it; it only quotes those numbers. A second check must agree, or confidence drops.";

/** Concatenated main-view text for tests and scrubbing (includes origin markers). */
export function journalMainText(journal: ServDecisionJournalView): string {
  const parts = [
    journal.title,
    JOURNAL_INTRO,
    ...journal.steps.flatMap((step) => [
      formatJournalStepSentences(step),
      formatJournalOriginMarker(step),
    ]),
    formatJournalSecondCheckSentences(journal.secondCheck),
  ];
  return parts.join(" ");
}
