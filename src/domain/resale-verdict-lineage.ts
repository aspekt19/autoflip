/**
 * Build a short buyer-facing Resale verdict lineage from the decision journal.
 * Never invents steps — only paraphrases what the journal already recorded.
 */

import type { ResaleDecisionJournal } from "./resale-decision-journal";

export type ResaleVerdictLineage = {
  /** One line: SERV pick: buy → margin guardrail: negotiate → final verdict: needs_inspection (reason) */
  chain: string;
  servPick: string | null;
  guardrail: string | null;
  finalVerdict: string;
  reason: string | null;
};

function actionFromDecided(decided: string): string | null {
  const match = decided.match(/→\s*(buy|negotiate|pass|needs_inspection)\b/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function isSuccessfulServPick(decided: string, rejected: string | null): boolean {
  if (rejected) return false;
  // Exact pick step — not "Challenge revised pick …", not decide, not rejected/unavailable.
  if (!/^Pick\s+/i.test(decided.trim())) return false;
  if (/rejected|unavailable|timed?\s*out|timeout/i.test(decided)) return false;
  return true;
}

/**
 * Derive lineage from journal steps plus the published final action.
 * SERV pick comes only from a successful pick step or the guardrail "SERV said …" line.
 */
export function resaleVerdictLineage(
  journal: ResaleDecisionJournal | null | undefined,
  finalAction: string,
): ResaleVerdictLineage | null {
  if (!journal?.steps.length) return null;
  let servPick: string | null = null;
  let guardrail: string | null = null;
  let guardrailWhy: string | null = null;
  let decideWhy: string | null = null;
  let codeFallback: string | null = null;

  for (const step of journal.steps) {
    if (step.actor === "SERV" && isSuccessfulServPick(step.decided, step.rejected)) {
      const action = actionFromDecided(step.decided);
      if (action && servPick == null) servPick = action;
    }

    if (
      step.actor === "SERV" &&
      /Verdict decide/i.test(step.decided) &&
      !step.rejected &&
      step.why?.trim() &&
      /Gate result:/i.test(step.why)
    ) {
      decideWhy = step.why.trim();
    }

    if (
      step.actor === "SERV" &&
      (/Pick rejected|Pick unavailable|Pick .*timed?\s*out|timeout/i.test(step.decided) ||
        (step.rejected != null && /^Pick\s+/i.test(step.decided)))
    ) {
      codeFallback = step.why?.trim() || step.decided;
    }

    if (step.actor === "code" && /Guardrail capped SERV/i.test(step.decided)) {
      const to = step.decided.match(/→\s*(buy|negotiate|pass|needs_inspection)\b/i)?.[1];
      const from =
        step.decided.match(/SERV\s+(buy|negotiate|pass|needs_inspection)\b/i)?.[1] ??
        step.why?.match(/SERV said\s+(buy|negotiate|pass|needs_inspection)\b/i)?.[1];
      if (to) {
        guardrail = to.toLowerCase();
        if (from && !servPick) servPick = from.toLowerCase();
      }
      guardrailWhy = step.why?.trim() || null;
    }
  }

  const final = finalAction.trim().toLowerCase();
  if (!servPick && !guardrail && !codeFallback) {
    return {
      chain: `Final verdict: ${final}`,
      servPick: null,
      guardrail: null,
      finalVerdict: final,
      reason: decideWhy,
    };
  }

  const parts: string[] = [];
  if (servPick) parts.push(`SERV pick: ${servPick}`);
  else if (codeFallback) parts.push("code fallback");
  if (guardrail) parts.push(`margin guardrail: ${guardrail}`);
  parts.push(`final verdict: ${final}`);

  // Prefer guardrail why (margin numbers); else decide why that already cites Gate result.
  const reason = guardrailWhy || decideWhy || (codeFallback && !servPick ? codeFallback : null);
  const reasonSuffix = reason
    ? ` (${reason.length > 180 ? `${reason.slice(0, 177)}…` : reason})`
    : "";

  return {
    chain: `${parts.join(" → ")}${reasonSuffix}`,
    servPick,
    guardrail,
    finalVerdict: final,
    reason,
  };
}
