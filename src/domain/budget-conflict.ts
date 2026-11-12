/**
 * Budget precedence when note text and an explicit form field disagree.
 *
 * Rule: an untouched / default form field never overrides an explicit budget in
 * the note (or SERV plan grounded from that note). When the shopper explicitly
 * edits the form and that number conflicts with the note, keep the form value
 * and surface a journalable conflict for SERV.
 */

export type BudgetConflict = {
  noteUsd: number;
  formUsd: number;
  chosenUsd: number;
  chosenSource: "form";
  journalLine: string;
};

export type ResolveBudgetInput = {
  /** Budget parsed from the shopper note (null when absent). */
  noteUsd: number | null;
  /** Numeric form value (may be a default/placeholder). */
  formUsd: number | null;
  /** True only when the shopper explicitly edited the budget field. */
  formDirty: boolean;
};

export type ResolveBudgetResult = {
  /** Value to enforce, or null when neither source has a budget. */
  budgetUsd: number | null;
  /** Provenance for SearchSpec hard.priceMaxUsd.source. */
  source: "form" | "note" | null;
  conflict: BudgetConflict | null;
};

function roundUsd(n: number): number {
  return Math.round(n);
}

/** True when two budgets differ by more than $1 (rounding noise). */
export function budgetsConflict(a: number, b: number): boolean {
  return Math.abs(roundUsd(a) - roundUsd(b)) > 1;
}

/**
 * Resolve note vs explicit form budget.
 * Untouched form never wins over note. Explicit form wins on conflict and is journaled.
 */
export function resolveBudgetPrecedence(input: ResolveBudgetInput): ResolveBudgetResult {
  const note =
    input.noteUsd != null && Number.isFinite(input.noteUsd) && input.noteUsd >= 1000
      ? roundUsd(input.noteUsd)
      : null;
  const form =
    input.formUsd != null && Number.isFinite(input.formUsd) && input.formUsd >= 1000
      ? roundUsd(input.formUsd)
      : null;

  if (input.formDirty && form != null) {
    if (note != null && budgetsConflict(note, form)) {
      const conflict: BudgetConflict = {
        noteUsd: note,
        formUsd: form,
        chosenUsd: form,
        chosenSource: "form",
        journalLine: `budget_conflict: form=$${form.toLocaleString("en-US")} note=$${note.toLocaleString("en-US")} — kept explicit form per precedence rule`,
      };
      return { budgetUsd: form, source: "form", conflict };
    }
    return { budgetUsd: form, source: "form", conflict: null };
  }

  if (note != null) return { budgetUsd: note, source: "note", conflict: null };
  if (form != null) return { budgetUsd: form, source: "note", conflict: null };
  return { budgetUsd: null, source: null, conflict: null };
}
