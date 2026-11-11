import { describe, expect, it } from "vitest";
import { emptyAgentVerdict } from "./agent-verdict-schema";
import type { DecisionProofRecord } from "./decision-proof-view";
import { DECISION_PROOF_SCHEMA, VERDICT_RUBRIC_ID } from "./decision-proof-view";
import {
  formatJournalSecondCheckSentences,
  formatJournalStepSentences,
  JOURNAL_BANNED_JARGON,
  journalMainText,
  journalMainTextViolations,
} from "./serv-decision-journal-copy";
import {
  buildServDecisionJournal,
  emptyServDecisionStep,
  summarizeSecondCheck,
} from "./serv-decision-step";

const digest = "a".repeat(64);

function proof(
  partial: Partial<DecisionProofRecord> & Pick<DecisionProofRecord, "purpose" | "status">,
): DecisionProofRecord {
  return {
    schemaVersion: DECISION_PROOF_SCHEMA,
    rubricId: VERDICT_RUBRIC_ID,
    servResponseId: partial.status === "ok" ? "chatcmpl-synthetic-test-ok" : null,
    model: partial.status === "ok" ? "synthetic-test-model" : null,
    timestamp: "2026-11-11T00:00:00.000Z",
    inputsDigest: digest,
    verdict: partial.status === "ok" ? "negotiate" : null,
    clampResult: null,
    reason: partial.status === "ok" ? null : "gates withheld decide",
    ...partial,
  };
}

describe("serv-decision-journal-copy", () => {
  it("formats steps as plain sentences without snake_case, tags, or jargon", () => {
    const steps = [
      emptyServDecisionStep({
        step: "need_extract",
        by: "SERV",
        status: "ran",
        output: "SUV, all-wheel drive, under 70k miles, 2020 or newer, around $20k",
        runId: "chatcmpl-synthetic-test-need",
        modelId: "synthetic-test-model",
        inputSummary: `inputs digest ${digest.slice(0, 12)}…`,
      }),
      emptyServDecisionStep({
        step: "verdict_decide",
        by: "SERV",
        status: "ran",
        output: "Decided negotiate",
        runId: "chatcmpl-synthetic-test-decide",
      }),
      emptyServDecisionStep({
        step: "find_pick",
        by: "SERV",
        status: "ran",
        output: "Decided buy",
      }),
      emptyServDecisionStep({
        step: "verdict_challenge",
        by: "SERV",
        status: "ran",
        output: "agreed",
      }),
      emptyServDecisionStep({
        step: "comps_verify",
        by: "code",
        status: "ran",
        output: "fair value from comps",
      }),
      emptyServDecisionStep({
        step: "free_gov_recalls",
        by: "code",
        status: "ran",
        output: "NHTSA recall check",
      }),
      emptyServDecisionStep({
        step: "free_gov_vpic",
        by: "code",
        status: "ran",
        output: "vPIC VIN decode",
      }),
    ];

    for (const step of steps) {
      const text = formatJournalStepSentences(step);
      expect(journalMainTextViolations(text), text).toEqual([]);
      expect(text).not.toMatch(/need_extract|verdict_decide|find_pick|verdict_challenge/);
      expect(text).not.toMatch(/\[[^\]]+\]/);
      expect(text.split(/[.!?]/).filter((s) => s.trim()).length).toBeLessThanOrEqual(2);
    }
  });

  it("bans internal abbreviations in the main journal text", () => {
    expect(JOURNAL_BANNED_JARGON.length).toBeGreaterThan(10);
    const samples = [
      "NHTSA",
      "vPIC",
      "VIN decode",
      "comps",
      "TCO",
      "MSRP",
      "ZIP",
      "API",
      "LLM",
      "comparables",
    ];
    for (const sample of samples) {
      expect(journalMainTextViolations(sample), sample).not.toEqual([]);
    }

    const scrubbed = formatJournalStepSentences(
      emptyServDecisionStep({
        step: "trail_1",
        by: "SERV",
        status: "ran",
        output: "Checked NHTSA recalls, vPIC VIN decode, comps near ZIP, TCO and MSRP via API LLM",
      }),
    );
    expect(journalMainTextViolations(scrubbed), scrubbed).toEqual([]);
    expect(scrubbed).toMatch(/government recall database|factory details|similar cars|postal code|total cost|sticker price/i);
  });

  it("formats second check as a plain sentence", () => {
    expect(formatJournalSecondCheckSentences(summarizeSecondCheck({
      status: "agreed",
      action: "negotiate",
      objection: null,
      evidenceIds: [],
      confidenceBefore: "medium",
      confidenceAfter: "medium",
      responseId: "chatcmpl-synthetic-test-challenge",
      profile: "verdict_challenge",
    }))).toBe("A second independent SERV check agreed.");

    const disagreed = formatJournalSecondCheckSentences(
      summarizeSecondCheck({
        status: "disagreed",
        action: "pass",
        objection: "Risk evidence was under-weighted.",
        evidenceIds: ["ev_1"],
        confidenceBefore: "medium",
        confidenceAfter: "low",
        responseId: "chatcmpl-synthetic-test-challenge",
      }),
    );
    expect(journalMainTextViolations(disagreed)).toEqual([]);
    expect(disagreed).toMatch(/disagreed/i);
    expect(disagreed).not.toMatch(/verdict_challenge|medium|\[/);
  });

  it("keeps the full journal main text free of snake_case, tags, and jargon", () => {
    const journal = buildServDecisionJournal({
      proofRecords: [
        proof({ purpose: "need_guard", status: "ok", verdict: null }),
        proof({ purpose: "need_extract", status: "ok", verdict: null }),
        proof({ purpose: "verdict_decide", status: "ok" }),
        proof({ purpose: "verdict_challenge", status: "ok", verdict: "negotiate" }),
        proof({ purpose: "find_next_check", status: "skipped", reason: "paid call cap reached" }),
      ],
      agentVerdict: emptyAgentVerdict({
        no_serv_step: false,
        second_pass: {
          status: "agreed",
          action: "negotiate",
          objection: null,
          evidenceIds: [],
          confidenceBefore: "high",
          confidenceAfter: "high",
          responseId: "chatcmpl-synthetic-test-challenge",
          profile: "verdict_challenge",
        },
      }),
    });

    const main = journalMainText(journal);
    expect(journalMainTextViolations(main), main).toEqual([]);
    expect(main).toMatch(/How this decision was made/);
    expect(main).toMatch(/second independent SERV check agreed/i);
    expect(main).not.toMatch(/need_extract|find_pick|verdict_challenge|inputs digest|chatcmpl-/);
    expect(main).not.toMatch(/\bNHTSA\b|\bvPIC\b|\bcomps\b|\bTCO\b|\bMSRP\b|\bZIP\b|\bAPI\b|\bLLM\b/i);
  });

  it("explains code clamp without internal tags", () => {
    const text = formatJournalStepSentences(
      emptyServDecisionStep({
        step: "verdict_decide",
        by: "SERV",
        status: "ran",
        output: "Decided buy · code clamped buy → pass",
        runId: "chatcmpl-synthetic-test-clamp",
      }),
    );
    expect(text).toMatch(/suggested Buy/i);
    expect(text).toMatch(/Skip|Pass|changed/i);
    expect(journalMainTextViolations(text)).toEqual([]);
  });
});
