import { describe, expect, it } from "vitest";
import { emptyResaleJournal, appendJournalStep } from "./resale-decision-journal";
import { resaleVerdictLineage } from "./resale-verdict-lineage";

describe("resaleVerdictLineage", () => {
  it("builds SERV pick → guardrail → final chain from journal steps", () => {
    let journal = emptyResaleJournal();
    journal = appendJournalStep(journal, {
      kind: "pick",
      actor: "SERV",
      decided: "Pick 2016 Toyota Camry → buy",
      why: "Strong mid profit.",
      inputsUsed: ["vin:TEST"],
      changed: null,
      model: "m",
      responseId: "r1",
      recordedAt: "2026-11-10T05:00:00.000Z",
      rejected: null,
    });
    journal = appendJournalStep(journal, {
      kind: "fallback",
      actor: "code",
      decided: "Guardrail capped SERV buy → negotiate",
      why: "SERV said buy; guardrail capped to negotiate. Mid margin below buy floor.",
      inputsUsed: ["vin:TEST", "check:flip_margin_gate"],
      changed: "Published action buy → negotiate",
      model: "m",
      responseId: "r1",
      recordedAt: "2026-11-10T05:00:00.000Z",
      rejected: null,
    });
    journal = appendJournalStep(journal, {
      kind: "pick",
      actor: "SERV",
      decided: "Verdict decide → needs_inspection",
      why: "Buy is forbidden by the mandate. Gate result: Conservative flip margin is below the profit target of $1,200. Buy is forbidden.",
      inputsUsed: ["vin:TEST", "check:verdict_decide"],
      changed: null,
      model: "m",
      responseId: "r2",
      recordedAt: "2026-11-10T05:00:01.000Z",
      rejected: null,
    });

    const lineage = resaleVerdictLineage(journal, "needs_inspection");
    expect(lineage).not.toBeNull();
    expect(lineage!.servPick).toBe("buy");
    expect(lineage!.guardrail).toBe("negotiate");
    expect(lineage!.finalVerdict).toBe("needs_inspection");
    expect(lineage!.chain).toMatch(/SERV pick: buy/);
    expect(lineage!.chain).toMatch(/margin guardrail: negotiate/);
    expect(lineage!.chain).toMatch(/final verdict: needs_inspection/);
    // Prefer guardrail why (margin numbers) over decide Gate result when both exist.
    expect(lineage!.reason).toMatch(/Mid margin below buy floor/);
  });

  it("ignores rejected/timeout decide and Challenge revised pick for SERV pick", () => {
    let journal = emptyResaleJournal();
    journal = appendJournalStep(journal, {
      kind: "pick",
      actor: "SERV",
      decided: "Pick rejected — code keeps 2016 Camry",
      why: "SERV timed out after 12s",
      inputsUsed: ["vin:TEST"],
      changed: null,
      model: "m",
      responseId: null,
      recordedAt: "2026-11-10T05:00:00.000Z",
      rejected: "timeout",
    });
    journal = appendJournalStep(journal, {
      kind: "challenge",
      actor: "SERV",
      decided: "Challenge revised pick to 2014 Civic → pass",
      why: "Thin comps.",
      inputsUsed: ["vin:OTHER"],
      changed: null,
      model: "m",
      responseId: "r2",
      recordedAt: "2026-11-10T05:00:01.000Z",
      rejected: null,
    });
    journal = appendJournalStep(journal, {
      kind: "pick",
      actor: "SERV",
      decided: "Verdict decide → pass",
      why: "SERV timed out after 8s",
      inputsUsed: ["vin:TEST"],
      changed: null,
      model: "m",
      responseId: null,
      recordedAt: "2026-11-10T05:00:02.000Z",
      rejected: "timeout",
    });

    const lineage = resaleVerdictLineage(journal, "pass");
    expect(lineage!.servPick).toBeNull();
    expect(lineage!.chain).toMatch(/code fallback/);
    expect(lineage!.chain).not.toMatch(/SERV pick: pass/);
  });

  it("takes SERV pick from guardrail SERV said when pick step is absent", () => {
    let journal = emptyResaleJournal();
    journal = appendJournalStep(journal, {
      kind: "fallback",
      actor: "code",
      decided: "Guardrail capped SERV buy → negotiate",
      why: "SERV said buy; guardrail capped to negotiate. Mid margin $400 below $1,200 floor.",
      inputsUsed: ["vin:TEST"],
      changed: null,
      model: null,
      responseId: null,
      recordedAt: "2026-11-10T05:00:00.000Z",
      rejected: null,
    });
    const lineage = resaleVerdictLineage(journal, "negotiate");
    expect(lineage!.servPick).toBe("buy");
    expect(lineage!.guardrail).toBe("negotiate");
    expect(lineage!.reason).toMatch(/\$400/);
  });
});
