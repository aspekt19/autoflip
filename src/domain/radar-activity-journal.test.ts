import { describe, expect, it } from "vitest";
import {
  groupByHttpCall,
  journalFromRadarActivity,
  noAgentCallsWhy,
  RADAR_SERV_CALL_CAP,
} from "./radar-activity-journal";

describe("noAgentCallsWhy", () => {
  it("does not use prompt guard boilerplate as the empty-run reason", () => {
    expect(
      noAgentCallsWhy(["prompt guard: allow", "Email alerts are not configured. New matches stay in the Deal Radar page."]),
    ).not.toMatch(/prompt guard/i);
    expect(noAgentCallsWhy(["prompt guard: allow"], "already seen: 12")).toMatch(/already seen: 12/);
  });
});

describe("journalFromRadarActivity", () => {
  it("maps SERV activity rows into the shared Resale journal schema", () => {
    const journal = journalFromRadarActivity(
      [
        {
          at: "2026-11-09T12:00:00.000Z",
          searchId: "s1",
          vin: "1HGCM82633A004352",
          profile: "radar_review",
          modelRequested: "model-a",
          modelReported: "model-a",
          callId: "call-1",
          responseId: "resp_1",
          latencyMs: 120,
          ok: true,
          decision: "alert",
          note: "Mid profit 1200 from 6 comps.",
          alerted: true,
        },
      ],
      { notes: ["Email alerts are not configured."], startedAt: "2026-11-09T12:00:00.000Z" },
    );
    expect(journal.schemaVersion).toBe("lemonless.resale_journal.v1");
    expect(journal.steps[0]?.actor).toBe("SERV");
    expect(journal.steps[0]?.responseId).toBe("resp_1");
    expect(journal.steps[0]?.model).toBe("model-a");
    expect(journal.steps.some((step) => /Email alerts/i.test(step.why))).toBe(true);
  });

  it("records an honest empty journal when no SERV calls ran", () => {
    const journal = journalFromRadarActivity([], {
      notes: ["prompt guard: allow"],
      filterBreakdown: "already seen: 8, Not enough similar cars: 2",
    });
    expect(journal.steps[0]?.kind).toBe("stop_or_widen");
    expect(journal.servCalls).toBe(0);
    expect(journal.steps[0]?.why).toMatch(/already seen: 8/);
    expect(journal.steps[0]?.why).not.toMatch(/prompt guard/i);
  });

  it("counts one batched radar_review HTTP response as one SERV call, not N decisions", () => {
    const callId = "call-batch-1";
    // Provenance: recorded id from eval/results/latest.json.
    const responseId = "chatcmpl-EhAcU9ouce3ntAvdUPXxxARGjslqB";
    const vins = [
      "4T1BF1FK4GU197310",
      "JTMZD31V075052071",
      "1HGCM82633A004352",
      "2T1BURHE0JC123456",
      "3VW2B7AJ5HM123456",
    ];
    const journal = journalFromRadarActivity(
      vins.map((vin, index) => ({
        at: "2026-11-10T05:13:57.000Z",
        searchId: "s1",
        vin,
        profile: "radar_review",
        modelRequested: "model-a",
        modelReported: "model-a",
        callId,
        responseId,
        latencyMs: 4200,
        ok: true,
        decision: index < 2 ? "skip" : "alert",
        note: index < 2 ? "Thin margin." : "Alert worthy.",
        alerted: index >= 2,
      })),
    );
    expect(journal.servCalls).toBe(1);
    expect(journal.steps[0]?.decided).toMatch(/HTTP call — 5 decisions/);
    expect(journal.steps[0]?.decided).toMatch(/3 alert/);
    expect(journal.steps[0]?.decided).toMatch(/2 skip/);
    expect(journal.steps.filter((step) => /for 4T1BF1FK4GU197310/.test(step.decided)).length).toBe(1);
    expect(journal.steps.length).toBeGreaterThanOrEqual(6);
  });

  it("counts a timeout of 5 cars with null responseId as one HTTP call via callId", () => {
    const callId = "call-timeout-1";
    const at = "2026-11-10T05:14:00.000Z";
    const vins = ["V1", "V2", "V3", "V4", "V5"];
    // Production shape after fix: decision=timeout + note with seconds (from radarReviewFailureFields).
    const journal = journalFromRadarActivity(
      vins.map((vin) => ({
        at,
        searchId: "s1",
        vin,
        profile: "radar_review",
        modelRequested: "model-a",
        modelReported: "",
        callId,
        responseId: null,
        latencyMs: 40_000,
        ok: false,
        decision: "timeout",
        note: "SERV timed out after 40s",
        alerted: false,
      })),
    );
    expect(journal.servCalls).toBe(1);
    expect(journal.servCalls).toBeLessThanOrEqual(RADAR_SERV_CALL_CAP);
    expect(journal.steps[0]?.rejected).toBe("timeout");
    expect(journal.steps[0]?.decided).toMatch(/HTTP call — 5 decisions/);
    const child = journal.steps.find((step) => /for V1/.test(step.decided));
    expect(child).toBeTruthy();
    expect(child!.rejected).toBe("timeout");
    expect(child!.decided).toMatch(/timeout/);
    expect(child!.decided).not.toMatch(/\bskip\b/i);
  });

  it("does not label a missing VIN verdict as skip or http_error when HTTP succeeded", () => {
    const callId = "call-partial-1";
    const journal = journalFromRadarActivity([
      {
        at: "2026-11-10T05:15:00.000Z",
        searchId: "s1",
        vin: "ALERTVIN000000001",
        profile: "radar_review",
        modelRequested: "m",
        modelReported: "m",
        callId,
        responseId: "resp-ok",
        latencyMs: 900,
        ok: true,
        decision: "alert",
        note: "ok",
        alerted: true,
      },
      {
        at: "2026-11-10T05:15:00.000Z",
        searchId: "s1",
        vin: "MISSINGVIN0000001",
        profile: "radar_review",
        modelRequested: "m",
        modelReported: "m",
        callId,
        responseId: "resp-ok",
        latencyMs: 900,
        ok: true,
        decision: null,
        note: null,
        alerted: false,
      },
    ]);
    expect(journal.servCalls).toBe(1);
    const missing = journal.steps.find((step) => /MISSINGVIN0000001/.test(step.decided));
    expect(missing?.decided).toMatch(/no decision/);
    expect(missing?.decided).not.toMatch(/\bskip\b/i);
    expect(missing?.rejected).toBeNull();
    expect(missing?.why).toMatch(/No decision in this SERV response/i);
  });

  it("groups legacy rows without callId by profile+at+latency (not per VIN)", () => {
    const at = "2026-11-10T05:16:00.000Z";
    const groups = groupByHttpCall(
      ["A", "B", "C"].map((vin) => ({
        at,
        searchId: "s1",
        vin,
        profile: "radar_review",
        modelRequested: "m",
        modelReported: "m",
        callId: null,
        responseId: null,
        latencyMs: 12_000,
        ok: false,
        decision: null,
        note: "SERV timed out after 12s",
        alerted: false,
      })),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(3);
    const journal = journalFromRadarActivity(groups[0]!);
    expect(journal.servCalls).toBe(1);
  });
});
