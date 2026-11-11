/**
 * Buyer-facing Find lineage from real decision proof rows only.
 * Never invents SERV picks — only paraphrases recorded find_pick / clampResult / trail.
 */

import type { DecisionProofRecord } from "./decision-proof-view";

export type FindVerdictLineage = {
  /** One line: SERV pick: buy → decide: needs_inspection → final: needs_inspection */
  chain: string;
  /** find_pick action (buy/negotiate/…) when present; else decide clamp servChoice. */
  servPick: string | null;
  /** verdict_decide SERV choice (may differ from find_pick action). */
  decide: string | null;
  guardrail: string | null;
  finalVerdict: string | null;
};

/**
 * Prefer find_pick.verdict as the SERV pick action, then verdict_decide clamp for
 * decide/final. Falls back to clamp-only wording when find_pick is missing.
 */
export function findVerdictLineage(
  proofs: readonly DecisionProofRecord[] | null | undefined,
  finalAction?: string | null,
): FindVerdictLineage | null {
  if (!proofs?.length) return null;
  const reversed = [...proofs].reverse();
  const decide = reversed.find((row) => row.purpose === "verdict_decide" && row.status === "ok");
  if (!decide) return null;

  const findPick = reversed.find((row) => row.purpose === "find_pick" && row.status === "ok");
  const pickAction =
    (findPick?.verdict && String(findPick.verdict).trim()) || null;

  const clamp = decide.clampResult;
  const decideChoice =
    (clamp?.servChoice && String(clamp.servChoice).trim()) ||
    (decide.verdict && String(decide.verdict).trim()) ||
    null;
  const final =
    (clamp?.finalAction && String(clamp.finalAction).trim()) ||
    (finalAction && String(finalAction).trim()) ||
    (decide.verdict && String(decide.verdict).trim()) ||
    null;
  const overridden = Boolean(clamp?.overridden);

  // When find_pick recorded an action, that is the SERV pick; decide stays separate.
  const servPick = pickAction || decideChoice;
  const decideLabel = pickAction ? decideChoice : null;
  const guardrailBasis = decideLabel || decideChoice;
  const guardrail =
    overridden && final && guardrailBasis && final !== guardrailBasis ? final : null;

  const parts: string[] = [];
  if (servPick) parts.push(`SERV pick: ${servPick}`);
  if (decideLabel) parts.push(`decide: ${decideLabel}`);
  if (guardrail) parts.push(`guardrail: ${guardrail}`);
  if (final) parts.push(`final: ${final}`);
  if (parts.length === 0) return null;

  return {
    chain: parts.join(" → "),
    servPick,
    decide: decideLabel,
    guardrail,
    finalVerdict: final,
  };
}
