import { describe, expect, it } from "vitest";
import { emptyAgentVerdict } from "./agent-verdict-schema";
import type { DecisionProofRecord } from "./decision-proof-view";
import { DECISION_PROOF_SCHEMA, VERDICT_RUBRIC_ID } from "./decision-proof-view";
import {
  clampMissingOriginLabel,
  formatJournalOriginMarker,
  formatJournalSecondCheckSentences,
  formatJournalStepSentences,
  JOURNAL_BANNED_JARGON,
  journalMainText,
  journalMainTextViolations,
} from "./serv-decision-journal-copy";
import {
  buildServDecisionJournal,
  emptyServDecisionStep,
  stepFromDecisionProof,
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

  it("narrates the find decide path in plain English (facts, triage, decide, challenge)", () => {
    const journal = buildServDecisionJournal({
      proofRecords: [
        proof({ purpose: "find_triage", status: "ok", verdict: null }),
        proof({
          purpose: "find_decide",
          status: "ok",
          verdict: "negotiate",
          clampResult: {
            servChoice: "buy",
            finalAction: "negotiate",
            overridden: true,
            overrideReasons: ["asking price sat above the fair band"],
          },
        }),
        proof({ purpose: "find_challenge", status: "ok", verdict: "agree" }),
      ],
      agentVerdict: emptyAgentVerdict({
        no_serv_step: false,
        second_pass: {
          status: "agreed",
          action: "negotiate",
          objection: null,
          evidenceIds: [],
          confidenceBefore: "medium",
          confidenceAfter: "medium",
          responseId: "chatcmpl-synthetic-test-find-challenge",
          profile: "find_challenge",
        },
      }),
    });
    expect(journal.steps.map((s) => s.step)).toEqual([
      "facts_given",
      "find_triage",
      "find_decide",
      "find_challenge",
    ]);
    const main = journalMainText(journal);
    expect(journalMainTextViolations(main), main).toEqual([]);
    expect(main).toMatch(/public-record facts/i);
    expect(main).toMatch(/shortlisted/i);
    expect(main).toMatch(/suggested Buy/i);
    expect(main).toMatch(/Limited by safety rule:/i);
    expect(main).toMatch(/second independent SERV check/i);
    expect(main).not.toMatch(/find_triage|find_decide|find_challenge|facts_given/);
    const decide = journal.steps.find((s) => s.step === "find_decide")!;
    expect(decide.modelId).toBe("synthetic-test-model");
    expect(decide.runId).toBe("chatcmpl-synthetic-test-ok");
    expect(decide.timestamp).toBe("2026-11-11T00:00:00.000Z");
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
        origin: "rule_clamped",
        originReason: "safety rules changed the choice from buy to pass",
      }),
    );
    expect(text).toMatch(/suggested Buy/i);
    expect(text).toMatch(/Skip|Pass|changed/i);
    expect(journalMainTextViolations(text)).toEqual([]);
  });

  it("labels clamped steps as Limited by safety rule (fails if unlabeled)", () => {
    const proofRow: DecisionProofRecord = {
      schemaVersion: DECISION_PROOF_SCHEMA,
      purpose: "verdict_decide",
      rubricId: VERDICT_RUBRIC_ID,
      status: "ok",
      servResponseId: "chatcmpl-synthetic-test-clamp-2",
      model: "synthetic-test-model",
      timestamp: "2026-11-11T00:00:00.000Z",
      inputsDigest: digest,
      verdict: "pass",
      clampResult: {
        servChoice: "buy",
        finalAction: "pass",
        overridden: true,
        overrideReasons: ["do-not-drive recall matched this car"],
      },
      reason: null,
    };
    const clamped = stepFromDecisionProof(proofRow);
    expect(clamped.origin).toBe("rule_clamped");
    const marker = formatJournalOriginMarker(clamped);
    expect(marker).toMatch(/^Limited by safety rule:/i);
    expect(marker).toMatch(/do-not-drive recall/i);
    expect(clampMissingOriginLabel(clamped)).toBe(false);
    expect(journalMainTextViolations(marker)).toEqual([]);
    // Main journal text must include the safety label for every clamp.
    const journal = buildServDecisionJournal({ proofRecords: [proofRow] });
    expect(journalMainText(journal)).toMatch(/Limited by safety rule:/i);
  });

  it("marks free SERV decisions as Decided by SERV", () => {
    const free = emptyServDecisionStep({
      step: "verdict_decide",
      by: "SERV",
      status: "ran",
      output: "Decided negotiate",
      origin: "serv",
      runId: "chatcmpl-synthetic-test-free",
    });
    expect(formatJournalOriginMarker(free)).toBe("");
  });

  it("does not lowercase into SERV sERV when output already starts with SERV", () => {
    const text = formatJournalStepSentences({
      ...emptyServDecisionStep({
        step: "verdict_decide",
        by: "SERV",
        status: "ran",
        output: "SERV picked the confirmed AWD shortlist car after reading the public facts",
        origin: "serv",
        runId: "chatcmpl-synthetic-test-serv-prefix",
      }),
      // Unknown step → default branch that previously prepended who + lowercased SERV → "SERV sERV".
      step: "unknown_future_step" as never,
    });
    expect(text).toMatch(/^SERV picked the confirmed AWD/i);
    expect(text).not.toMatch(/SERV sERV/i);
  });

  it("labels find_challenge as a second independent SERV check (not free-gov recalls)", () => {
    const text = formatJournalStepSentences(
      emptyServDecisionStep({
        step: "find_challenge",
        by: "SERV",
        status: "ran",
        output: "agree",
        origin: "serv",
        runId: "chatcmpl-synthetic-test-find-challenge-label",
      }),
    );
    expect(text).toMatch(/second independent SERV check/i);
    expect(text).not.toMatch(/recall|government recall database/i);
  });
});
