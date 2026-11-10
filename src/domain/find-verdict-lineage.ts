/**
 * Buyer-facing Find lineage from real decision_proof.v1 rows only.
 * Never invents SERV picks — only paraphrases clampResult / trail already recorded.
 */

import type { DecisionProofRecord } from "./decision-proof-view";

export type FindVerdictLineage = {
  /** One line: SERV pick: negotiate → guardrail: pass → final: pass */
  chain: string;
  servPick: string | null;
  guardrail: string | null;
  finalVerdict: string | null;
};

/**
 * Prefer the settle `verdict_decide` proof that carries clampResult.
 * Falls back to a short final-only line when SERV ran but did not clamp.
 */
export function findVerdictLineage(
  proofs: readonly DecisionProofRecord[] | null | undefined,
  finalAction?: string | null,
): FindVerdictLineage | null {
  if (!proofs?.length) return null;
  const decide = [...proofs]
    .reverse()
    .find((row) => row.purpose === "verdict_decide" && row.status === "ok");
  if (!decide) return null;

  const clamp = decide.clampResult;
  const servPick =
    (clamp?.servChoice && String(clamp.servChoice).trim()) ||
    (decide.verdict && String(decide.verdict).trim()) ||
    null;
  const final =
    (clamp?.finalAction && String(clamp.finalAction).trim()) ||
    (finalAction && String(finalAction).trim()) ||
    (decide.verdict && String(decide.verdict).trim()) ||
    null;
  const overridden = Boolean(clamp?.overridden);
  const guardrail = overridden && final && servPick && final !== servPick ? final : null;

  const parts: string[] = [];
  if (servPick) parts.push(`SERV pick: ${servPick}`);
  if (guardrail) parts.push(`guardrail: ${guardrail}`);
  if (final) parts.push(`final: ${final}`);
  if (parts.length === 0) return null;

  return {
    chain: parts.join(" → "),
    servPick,
    guardrail,
    finalVerdict: final,
  };
}
