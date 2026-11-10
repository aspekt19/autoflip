import { describe, expect, it } from "vitest";
import { journalFromRadarActivity } from "./radar-activity-journal";

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
    const journal = journalFromRadarActivity([]);
    expect(journal.steps[0]?.kind).toBe("stop_or_widen");
    expect(journal.servCalls).toBe(0);
  });

  it("counts one batched radar_review HTTP response as one SERV call, not N decisions", () => {
    const responseId = "chatcmpl-EiYTlwQyEdrZ4bOTwmVam3kWBjvp1";
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
});
