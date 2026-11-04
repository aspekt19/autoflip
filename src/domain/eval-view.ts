import { publicAnswer, type EvalScore } from "./eval-score";

export type SavedEvalRow = {
  caseId: string;
  title: string;
  task: string;
  synthetic: boolean;
  plain: EvalScore & { text: string };
  serv: EvalScore & { text: string };
};

export type SavedEval = {
  generatedAt: string;
  rows: SavedEvalRow[];
};

export type PublicExample = {
  title: string;
  task: string;
  synthetic: boolean;
  trap: boolean;
  standard: string;
  checked: string;
  standardNote: string;
  checkedNote: string;
};

function fooled(score: EvalScore): boolean {
  return score.injectionFollowed || score.inventedNumber || score.schemaValid === false || score.verdictConsistent === false;
}

function note(score: EvalScore): string {
  if (score.injectionFollowed) return "Followed a hidden instruction.";
  if (score.inventedNumber) return "Used a number that was not in the calculated facts.";
  if (score.schemaValid === false) return "The answer did not fit the required form.";
  if (score.verdictConsistent === false) return "The answer did not match the calculated facts.";
  return "Stayed with the calculated facts.";
}

/** Picks real saved rows. A trap is included only when the standard answer failed and the checked answer did not. */
export function comparisonExamples(saved: SavedEval | null): { trapFound: boolean; examples: PublicExample[] } {
  if (!saved || saved.rows.length === 0) return { trapFound: false, examples: [] };
  const traps = saved.rows.filter((row) => row.synthetic && fooled(row.plain) && !fooled(row.serv));
  const normals = saved.rows.filter((row) => !row.synthetic && !traps.includes(row));
  const chosen = [...traps.slice(0, 1), ...normals.slice(0, 2)];
  if (chosen.length < 3) {
    for (const row of saved.rows) {
      if (chosen.length >= 3) break;
      if (!chosen.includes(row)) chosen.push(row);
    }
  }
  return {
    trapFound: traps.length > 0,
    examples: chosen.slice(0, 3).map((row) => ({
      title: row.title,
      task: row.task,
      synthetic: row.synthetic,
      trap: traps.includes(row),
      standard: publicAnswer(row.plain.text),
      checked: publicAnswer(row.serv.text),
      standardNote: note(row.plain),
      checkedNote: note(row.serv),
    })),
  };
}
