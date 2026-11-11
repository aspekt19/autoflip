/**
 * Buyer-facing copy for the "How this decision was made" journal.
 * Main view: one or two plain sentences. No snake_case step ids, bracketed tags,
 * model suffixes, response ids, digests, or JSON.
 */

import { plainDecisionAction } from "./find-buyer-copy";
import { buyerSafeResaleJournalText } from "./resale-journal-copy";
import type {
  ServDecisionJournalView,
  ServDecisionStep,
  ServSecondCheckSummary,
} from "./serv-decision-step";

/** Snake_case tokens and [bracketed] tags must not appear in the main journal view. */
const SNAKE_CASE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/;
const BRACKETED_TAG = /\[[^\]]+\]/;
const TECH_LEAK =
  /\b(chatcmpl-|response id|inputs digest|schemaVersion|rawResponse|TypeScript|JSON)\b/i;

export function journalMainTextViolations(text: string): string[] {
  const hits: string[] = [];
  const snake = text.match(SNAKE_CASE);
  if (snake) hits.push(snake[0]!);
  const bracket = text.match(BRACKETED_TAG);
  if (bracket) hits.push(bracket[0]!);
  const tech = text.match(TECH_LEAK);
  if (tech) hits.push(tech[0]!);
  return hits;
}

function scrubBuyerText(text: string): string {
  return buyerSafeResaleJournalText(
    text
      .replace(/\binputs digest\s+[a-f0-9]+…?/gi, "")
      .replace(/\bchatcmpl-[A-Za-z0-9_-]+/g, "")
      .replace(/\bresponse\s+[A-Za-z0-9_-]+/gi, "")
      .replace(/\bmodel\s+[A-Za-z0-9._-]+/gi, "")
      .replace(/\b(verdict_decide|verdict_challenge|need_extract|need_guard|find_next_check|find_pick|resale_[a-z_]+|radar_[a-z_]+)\b/gi, "")
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

/**
 * One or two plain sentences for a journal step. Never includes step ids, models, or hashes.
 */
export function formatJournalStepSentences(step: ServDecisionStep): string {
  const who = step.by === "SERV" ? "SERV" : "Code";
  const action = extractActionFromOutput(step.output);
  const clamp = extractClampActions(step.output);
  const reason = scrubBuyerText(step.output);

  if (step.status === "not_run") {
    return `${who} did not run this step.${reason ? ` ${reason}.` : ""}`.replace(/\.\s*\./g, ".");
  }
  if (step.status === "skipped") {
    const why = reason && !/^skipped$/i.test(reason) ? ` ${reason}.` : "";
    return `${who} skipped this step.${why}`.replace(/\.\s*\./g, ".");
  }
  if (step.status === "failed") {
    const why = reason ? ` ${reason}.` : "";
    return `${who} tried this step but it did not finish.${why}`.replace(/\.\s*\./g, ".");
  }

  switch (step.step) {
    case "need_guard":
      return "SERV screened your request before reading the details.";
    case "need_extract":
      return reason && reason.length > 12 && !/^Decision recorded$/i.test(reason)
        ? `SERV read your request and understood: ${reason.replace(/^Decided\s+/i, "")}.`
        : "SERV read your request and wrote down what you need.";
    case "find_next_check":
      return "SERV chose which check to run next from the allowed list. Code ran that check and saved the results.";
    case "find_pick":
      return action
        ? `SERV reviewed the shortlist and leaned toward ${action}.`
        : "SERV reviewed the shortlist and named which car to look at first.";
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
      return "SERV picked a car from the allowlisted shortlist. Profit figures came from code.";
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
      return reason
        ? `This listing was set aside. ${reason}.`
        : "This listing was set aside.";
    case "stop_or_widen":
      return "SERV decided whether to stop or widen the search.";
    case "fallback":
      return "Code used a built-in fallback because the model step was not available.";
    case "comps_verify":
    case "price_badge":
      return "Code calculated the asking price, fair value, and similar listings.";
    case "gates":
    case "report_gates":
      return "Code checked safety rules before publishing the answer.";
    default: {
      if (step.by === "code") {
        return reason && reason.length > 8
          ? `Code verified this part. ${reason}.`
          : "Code verified the numbers for this step.";
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
  by: ServDecisionStep["by"];
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
  };
};

export function journalStepViews(steps: readonly ServDecisionStep[]): JournalStepView[] {
  return steps.map((step) => ({
    sentences: formatJournalStepSentences(step),
    by: step.by,
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
    },
  }));
}

/** Concatenated main-view text for tests and scrubbing. */
export function journalMainText(journal: ServDecisionJournalView): string {
  const parts = [
    journal.title,
    ...journal.steps.map(formatJournalStepSentences),
    formatJournalSecondCheckSentences(journal.secondCheck),
  ];
  return parts.join(" ");
}
