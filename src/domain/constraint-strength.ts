/**
 * Hard vs soft from the words that govern a requirement.
 * "must / need / required" makes it a limit. "preferably / ideally / if possible"
 * makes it a ranking preference. A bare mention ("with AWD") is a limit.
 * The modality closest to the requirement wins, and a hard verb that takes
 * the requirement as its object wins over a later preference about something else.
 */

export type ConstraintStrength = "hard" | "soft";

const HARD_MODAL = /\b(?:must|needs?|needed|require[ds]?|required|have to|has to|only)\b/gi;
const SOFT_MODAL = /\b(?:preferably|preferred|prefer|ideally|if possible|nice to have|would like|would prefer)\b/gi;
const SOFT_HEDGE = /^\s*(?:,|;)?\s*(?:if possible|preferably|ideally)\b/i;

function lastIndex(text: string, pattern: RegExp): number {
  pattern.lastIndex = 0;
  let at = -1;
  for (const match of text.matchAll(pattern)) {
    if (match.index != null) at = match.index;
  }
  return at;
}

/** Split on sentences, and on a comma that starts a new must/prefer phrase. */
export function constraintClauses(text: string): string[] {
  const out: string[] = [];
  for (const sentence of text.split(/[.!?]+/)) {
    const parts = sentence.split(",");
    let buf = "";
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const startsModal = lastIndex(trimmed, HARD_MODAL) === 0 || lastIndex(trimmed, SOFT_MODAL) === 0;
      if (buf && startsModal) {
        out.push(buf);
        buf = trimmed;
      } else {
        buf = buf ? `${buf}, ${trimmed}` : trimmed;
      }
    }
    if (buf) out.push(buf);
  }
  return out;
}

/**
 * Strength of `subject` in this note.
 * Null when the subject is not mentioned.
 */
export function constraintStrength(text: string, subject: RegExp): ConstraintStrength | null {
  const flagged = new RegExp(subject.source, subject.flags.includes("i") ? "i" : "");
  if (!flagged.test(text)) return null;
  let sawSoft = false;
  let sawBare = false;
  for (const clause of constraintClauses(text)) {
    const finder = new RegExp(subject.source, subject.flags.includes("g") ? subject.flags : `${subject.flags}g`);
    const match = finder.exec(clause);
    if (!match || match.index == null) continue;
    const before = clause.slice(0, match.index);
    const after = clause.slice(match.index + match[0].length, match.index + match[0].length + 32);
    const hardAt = lastIndex(before, HARD_MODAL);
    const softAt = lastIndex(before, SOFT_MODAL);
    const hardNear = hardAt >= 0 && before.length - hardAt <= 32;
    const softNear = softAt >= 0 && before.length - softAt <= 32;
    if (hardNear && hardAt >= softAt) return "hard";
    if (softNear && softAt > hardAt) {
      sawSoft = true;
      continue;
    }
    if (SOFT_HEDGE.test(after)) {
      sawSoft = true;
      continue;
    }
    sawBare = true;
  }
  if (sawBare) return "hard";
  if (sawSoft) return "soft";
  return "hard";
}
