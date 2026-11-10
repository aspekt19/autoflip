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
});
