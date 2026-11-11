/**
 * Yura hard rule: consumer-facing copy must not leak internal codes outside Show proof.
 */
import { describe, expect, it } from "vitest";
import {
  consumerDecisionSummaryLines,
  formatDecisionRecordConsumerLine,
  type DecisionProofRecord,
} from "./decision-proof-view";
import { intentSummaryFromNeed } from "./directions";
import { explicitNeedFromText } from "./need";
import { findEmptyCopy } from "./find-empty";

/** Tokens that must never appear in the main consumer view (outside Show proof). */
const INTERNAL_LEAK =
  /\b(?:need_guard|need_extract|find_next_check|find_pick|verdict_decide|verdict_challenge|widen_or_nationwide|consistency_deterministic_drain|failureDiag|allowlisted|message_content_null_refusal_field|chatcmpl-[A-Za-z0-9]+|ev_note_\d+|priceUsd|sellerName|loop guard|RCA)\b|:\s*(?:car|ask|fair|comps):/i;

function assertPlain(label: string, text: string) {
  expect(text, label).not.toMatch(INTERNAL_LEAK);
  expect(text, label).not.toMatch(/\b[a-z]+_[a-z]+(?:_[a-z]+)+\b/); // snake_case purpose-like tokens
}

describe("consumer plain-language scan (outside Show proof)", () => {
  it("intent summary lines stay plain", () => {
    const need = explicitNeedFromText(
      "Looking for a used SUV around $20k. Preferably AWD, reliable for road trips, near me.",
      "personal",
    );
    for (const line of intentSummaryFromNeed(need)) {
      assertPlain(`intent:${line}`, line);
    }
  });

  it("empty-copy headlines/details/nextSteps stay plain", () => {
    const need = explicitNeedFromText("SUV commute under 20k", "personal");
    for (const reason of [
      "no_directions",
      "empty_inventory",
      "incomplete_search",
      "invalid_need",
    ] as const) {
      const copy = findEmptyCopy(reason, need);
      assertPlain(`${reason}.headline`, copy.headline);
      assertPlain(`${reason}.detail`, copy.detail);
      assertPlain(`${reason}.nextStep`, copy.nextStep);
    }
  });

  it("consumer decision summary lines stay plain", () => {
    const records: DecisionProofRecord[] = [
      {
        schemaVersion: "lemonless.decision_proof.v1",
        purpose: "find_pick",
        rubricId: "synthetic-test-rubric",
        status: "ok",
        servResponseId: "synthetic-test-pick-1",
        model: "gpt-5.4-mini-2026-03-17",
        timestamp: "2026-11-11T17:00:00.000Z",
        inputsDigest: "synthetic-test-digest",
        verdict: "buy",
        clampResult: null,
        reason: "Best overall finalist among eligible cars.",
        rawResponse: '{"pickKey":"synthetic-test-vin","action":"buy","evidenceIds":["car:x","ask:x"]}',
        searchId: null,
        ownerId: null,
      },
      {
        schemaVersion: "lemonless.decision_proof.v1",
        purpose: "verdict_decide",
        rubricId: "synthetic-test-rubric",
        status: "ok",
        servResponseId: "synthetic-test-decide-1",
        model: "gpt-5.4-mini-2026-03-17",
        timestamp: "2026-11-11T17:00:10.000Z",
        inputsDigest: "synthetic-test-digest-2",
        verdict: "needs_inspection",
        clampResult: null,
        reason: "Accident history is missing.",
        rawResponse: null,
        searchId: null,
        ownerId: null,
      },
      {
        schemaVersion: "lemonless.decision_proof.v1",
        purpose: "find_next_check",
        rubricId: "synthetic-test-rubric",
        status: "skipped",
        servResponseId: null,
        model: null,
        timestamp: "2026-11-11T17:00:05.000Z",
        inputsDigest: "synthetic-test-digest-3",
        verdict: null,
        clampResult: null,
        reason: "SERV not invoked this hop (consistency_deterministic_drain).",
        rawResponse: null,
        searchId: null,
        ownerId: null,
      },
    ];
    for (const line of consumerDecisionSummaryLines(records)) {
      assertPlain(`summary:${line}`, line);
      expect(line).not.toMatch(/chatcmpl/i);
      expect(line).not.toMatch(/find_pick|verdict_decide|consistency_deterministic/i);
    }
    for (const row of records) {
      const consumer = formatDecisionRecordConsumerLine(row);
      assertPlain(`record:${row.purpose}`, consumer);
    }
  });
});
