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

/**
 * Derive lineage from journal steps plus the published final action.
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

  for (const step of journal.steps) {
    if (step.actor === "SERV" && (step.kind === "pick" || /Pick |Verdict decide/i.test(step.decided))) {
      const action = actionFromDecided(step.decided);
      if (action) {
        // Prefer the earliest SERV pick; later decide may overwrite for display as final.
        if (servPick == null || /Pick /i.test(step.decided)) servPick = action;
      }
      if (/Verdict decide/i.test(step.decided) && step.why?.trim()) {
        decideWhy = step.why.trim();
      }
    }
    if (step.actor === "code" && /Guardrail capped SERV/i.test(step.decided)) {
      const to = step.decided.match(/→\s*(buy|negotiate|pass|needs_inspection)\b/i)?.[1];
      const from = step.decided.match(/SERV\s+(buy|negotiate|pass|needs_inspection)\b/i)?.[1];
      if (to) {
        guardrail = to.toLowerCase();
        if (from && !servPick) servPick = from.toLowerCase();
      }
      guardrailWhy = step.why?.trim() || null;
    }
  }

  const final = finalAction.trim().toLowerCase();
  if (!servPick && !guardrail) {
    // Still show final when no SERV pick was recorded.
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
  if (guardrail) parts.push(`margin guardrail: ${guardrail}`);
  parts.push(`final verdict: ${final}`);

  const reason =
    decideWhy ||
    guardrailWhy ||
    null;
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
