import { describe, expect, it } from "vitest";
import { emptyResaleJournal, appendJournalStep } from "./resale-decision-journal";
import { resaleVerdictLineage } from "./resale-verdict-lineage";

describe("resaleVerdictLineage", () => {
  it("builds SERV pick → guardrail → final chain from journal steps", () => {
    let journal = emptyResaleJournal(6);
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
    expect(lineage!.reason).toMatch(/Gate result:/);
    expect(lineage!.reason).toMatch(/profit target/);
  });
});
