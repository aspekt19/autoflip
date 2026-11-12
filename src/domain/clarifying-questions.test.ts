import { describe, expect, it } from "vitest";
import {
  clarifyingQaFromRunLines,
  formatClarifyingQaLines,
  noteWithClarifyingQa,
  parseClarifyingAnswers,
  validateClarifyingQuestions,
} from "./clarifying-questions";

describe("clarifying questions shape validation", () => {
  it("keeps non-empty text, caps count and length", () => {
    const qs = validateClarifyingQuestions([
      { text: "  What ZIP are you shopping near?  " },
      { text: "" },
      "What's your max budget?",
      { text: "x".repeat(400) },
      { text: "extra 1" },
      { text: "extra 2" },
      { text: "extra 3" },
    ]);
    expect(qs).toHaveLength(5);
    expect(qs[0]!.text).toBe("What ZIP are you shopping near?");
    expect(qs[1]!.text).toBe("What's your max budget?");
    expect(qs[2]!.text.length).toBe(200);
  });

  it("parses answers and formats run lines", () => {
    const pairs = parseClarifyingAnswers([
      { question: "What ZIP?", answer: "33101" },
      { question: "Max budget?", answer: "", skipped: true },
    ]);
    expect(pairs[0]).toMatchObject({ question: "What ZIP?", answer: "33101", skipped: false });
    expect(pairs[1]!.skipped).toBe(true);
    expect(formatClarifyingQaLines(pairs)).toEqual([
      "Q: What ZIP? A: 33101",
      "Q: Max budget? A: (skipped)",
    ]);
    const revived = clarifyingQaFromRunLines(formatClarifyingQaLines(pairs));
    expect(revived[0]!.answer).toBe("33101");
    expect(revived[1]!.skipped).toBe(true);
  });

  it("merges Q&A into note for grounding", () => {
    const merged = noteWithClarifyingQa("SUV under something", [
      { question: "What is your max budget?", answer: "18000" },
    ]);
    expect(merged).toMatch(/SUV under something/);
    expect(merged).toMatch(/Q: What is your max budget\? A: 18000/);
  });
});
