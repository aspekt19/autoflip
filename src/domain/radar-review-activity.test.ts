import { describe, expect, it } from "vitest";
import { journalFromRadarActivity } from "./radar-activity-journal";
import {
  buildRadarReviewActivityRows,
  flipCandidateOutcome,
  radarReviewFailureFields,
  upsertNotReviewedAlert,
} from "./radar-review-activity";

describe("radarReviewFailureFields", () => {
  it("labels SERV did not respond as timeout with seconds", () => {
    const fail = radarReviewFailureFields({
      error: "SERV did not respond.",
      status: 0,
      latencyMs: 40_000,
    });
    expect(fail.decision).toBe("timeout");
    expect(fail.note).toBe("SERV timed out after 40s");
  });

  it("labels HTTP status errors honestly", () => {
    const fail = radarReviewFailureFields({
      error: "upstream 502",
      status: 502,
      latencyMs: 1200,
    });
    expect(fail.decision).toBe("http_error");
    expect(fail.note).toMatch(/HTTP 502/);
  });
});

describe("buildRadarReviewActivityRows (production timeout shape)", () => {
  it("writes timeout note/decision the way judgeFlipAlerts does — journal rejects as timeout, not http_error", () => {
    const callId = "call-prod-timeout";
    const vins = ["4T1BF1FK4GU197310", "JTMZD31V075052071", "1HGCM82633A004352", "VIN4", "VIN5"];
    // Same inputs judgeFlipAlerts passes after runServ fails with "SERV did not respond."
    const rows = buildRadarReviewActivityRows(
      vins.map((vin) => ({
        at: "2026-11-10T05:14:00.000Z",
        searchId: "s1",
        vin,
        callId,
        responseId: null,
        latencyMs: 40_000,
        modelRequested: "model-a",
        modelReported: "",
      })),
      {
        ok: false,
        error: "SERV did not respond.",
        status: 0,
        decisions: null,
      },
    );
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.callId === callId)).toBe(true);
    expect(rows.every((row) => row.ok === false)).toBe(true);
    expect(rows.every((row) => row.decision === "timeout")).toBe(true);
    expect(rows.every((row) => row.note === "SERV timed out after 40s")).toBe(true);
    expect(rows.every((row) => row.alerted === false)).toBe(true);

    const journal = journalFromRadarActivity(rows);
    expect(journal.servCalls).toBe(1);
    expect(journal.steps[0]?.rejected).toBe("timeout");
    expect(journal.steps[0]?.why).toMatch(/timed out after 40s/i);
    expect(journal.steps.every((step) => step.rejected !== "http_error")).toBe(true);
  });
});

describe("flipCandidateOutcome", () => {
  it("labels Flip code-only alerts with the same code price rating sentence as Drive-it", () => {
    const outcome = flipCandidateOutcome({
      hasServKey: false,
      decisions: null,
      vin: "4T1BF1FK4GU197310",
      baseWhy: "Mid profit $600.",
    });
    expect(outcome.kind).toBe("code_alert");
    if (outcome.kind === "code_alert") {
      expect(outcome.why).toMatch(/uses the code price rating only/i);
      expect(outcome.why).toMatch(/SERV was not configured/i);
    }
  });

  it("marks every car Not reviewed when there is no decision map (timeout path)", () => {
    const outcome = flipCandidateOutcome({
      hasServKey: true,
      decisions: null,
      vin: "4T1BF1FK4GU197310",
      baseWhy: "Mid profit $600.",
    });
    expect(outcome.kind).toBe("not_reviewed");
    if (outcome.kind === "not_reviewed") {
      expect(outcome.why).toMatch(/Not reviewed — SERV did not return a decision/i);
      expect(outcome.why).toMatch(/will retry on next Check/i);
    }
  });

  it("does not count alerts when decision map is absent — alertsSent stays unchanged", () => {
    let alertsSent = 0;
    const vins = ["A", "B", "C", "D", "E"];
    for (const vin of vins) {
      const outcome = flipCandidateOutcome({
        hasServKey: true,
        decisions: null,
        vin,
        baseWhy: "scan",
      });
      if (outcome.kind === "alert" || outcome.kind === "code_alert") alertsSent += 1;
    }
    expect(alertsSent).toBe(0);
  });
});

describe("upsertNotReviewedAlert", () => {
  it("replaces an existing not_reviewed row for the same search+VIN", () => {
    const prior = {
      id: "old",
      searchId: "s1",
      vin: "VIN1",
      status: "not_reviewed",
      why: "old",
    };
    const other = {
      id: "keep",
      searchId: "s1",
      vin: "VIN2",
      status: "new",
      why: "alert",
    };
    const next = {
      id: "new",
      searchId: "s1",
      vin: "VIN1",
      status: "not_reviewed",
      why: "Not reviewed (no SERV decision).",
    };
    const rows = upsertNotReviewedAlert([prior, other], next);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(next);
    expect(rows.some((row) => row.id === "old")).toBe(false);
    expect(rows.some((row) => row.id === "keep")).toBe(true);
  });
});
