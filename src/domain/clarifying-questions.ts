/**
 * SERV-owned clarifying questions for Find and Resale.
 * Code validates shape only — never invents question ids or prompts.
 */

export const MAX_CLARIFYING_QUESTIONS = 5;
export const MAX_CLARIFYING_QUESTION_LENGTH = 200;
export const MAX_CLARIFYING_ANSWER_LENGTH = 500;

export type ClarifyingQuestion = { text: string };

export type ClarifyingQaPair = {
  question: string;
  answer: string;
  skipped?: boolean;
};

export function validateClarifyingQuestions(raw: unknown): ClarifyingQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: ClarifyingQuestion[] = [];
  for (const item of raw) {
    if (out.length >= MAX_CLARIFYING_QUESTIONS) break;
    let text = "";
    if (typeof item === "string") text = item.trim();
    else if (item && typeof item === "object" && !Array.isArray(item)) {
      const row = item as Record<string, unknown>;
      if (typeof row.text === "string") text = row.text.trim();
    }
    if (!text) continue;
    out.push({ text: text.slice(0, MAX_CLARIFYING_QUESTION_LENGTH) });
  }
  return out;
}

export function parseClarifyingAnswers(raw: unknown): ClarifyingQaPair[] {
  if (!Array.isArray(raw)) return [];
  const out: ClarifyingQaPair[] = [];
  for (const item of raw) {
    if (out.length >= MAX_CLARIFYING_QUESTIONS) break;
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const question = typeof row.question === "string" ? row.question.trim() : "";
    if (!question) continue;
    const answerRaw = typeof row.answer === "string" ? row.answer.trim() : "";
    const skipped = row.skipped === true || !answerRaw;
    out.push({
      question: question.slice(0, MAX_CLARIFYING_QUESTION_LENGTH),
      answer: skipped ? "" : answerRaw.slice(0, MAX_CLARIFYING_ANSWER_LENGTH),
      skipped,
    });
  }
  return out;
}

export function formatClarifyingQaLine(pair: ClarifyingQaPair): string {
  const q = pair.question.trim();
  if (pair.skipped || !pair.answer.trim()) return `Q: ${q} A: (skipped)`;
  return `Q: ${q} A: ${pair.answer.trim()}`;
}

export function formatClarifyingQaLines(pairs: readonly ClarifyingQaPair[]): string[] {
  return pairs.map(formatClarifyingQaLine).filter(Boolean);
}

export function clarifyingQaContextBlock(pairs: readonly ClarifyingQaPair[]): string {
  if (!pairs.length) return "";
  return `Shopper clarifying Q&A (answer before searching; do not invent answers):\n${formatClarifyingQaLines(pairs).join("\n")}`;
}

export function noteWithClarifyingQa(
  note: string,
  pairs: readonly ClarifyingQaPair[] | null | undefined,
): string {
  const base = (note ?? "").trim();
  if (!pairs?.length) return base;
  const block = clarifyingQaContextBlock(pairs);
  return base ? `${base}\n\n${block}` : block;
}

export function clarifyingQaFromRunLines(lines: readonly string[] | null | undefined): ClarifyingQaPair[] {
  if (!lines?.length) return [];
  const out: ClarifyingQaPair[] = [];
  for (const line of lines) {
    if (out.length >= MAX_CLARIFYING_QUESTIONS) break;
    const trimmed = typeof line === "string" ? line.trim() : "";
    const match = /^Q:\s*(.*?)\s+A:\s*(.*)$/s.exec(trimmed);
    if (!match) continue;
    const question = (match[1] ?? "").trim();
    const answerRaw = (match[2] ?? "").trim();
    if (!question) continue;
    const skipped = !answerRaw || /^\(skipped\)$/i.test(answerRaw);
    out.push({
      question: question.slice(0, MAX_CLARIFYING_QUESTION_LENGTH),
      answer: skipped ? "" : answerRaw.slice(0, MAX_CLARIFYING_ANSWER_LENGTH),
      skipped,
    });
  }
  return out;
}
