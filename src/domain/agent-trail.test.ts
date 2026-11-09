import { describe, expect, it } from "vitest";
import { reconcileMultipathDeterministic } from "./agent-multipath";
import {
  buildAgentVerdictFromFind,
  buildAgentVerdictFromReport,
  trailStepFromMultipath,
  trailStepFromSecondPass,
} from "./agent-trail";
import type { FindDecisionLogEntry } from "./find-decision-log";
import { AGENT_VERDICT_JSON_SCHEMA, AGENT_VERDICT_SCHEMA_VERSION } from "./agent-verdict-schema";

const labels = [
  { key: "a", year: 2020, make: "Toyota", model: "Camry", priceUsd: 18_000 },
  { key: "b", year: 2019, make: "Honda", model: "Accord", priceUsd: 16_500 },
];

function hop(partial: Partial<FindDecisionLogEntry> & Pick<FindDecisionLogEntry, "hop" | "action">): FindDecisionLogEntry {
  return {
    decidedBy: "code",
    invokeReason: "free_gov_deterministic_drain",
    targetCars: [],
    evidenceAdded: [],
    top5Before: [
      { key: "a", rank: 1 },
      { key: "b", rank: 2 },
    ],
    top5After: [
      { key: "a", rank: 1 },
      { key: "b", rank: 2 },
    ],
    pickBefore: "a",
    pickAfter: "a",
    ...partial,
  };
}

describe("agent trail + multipath", () => {
  it("exports a documented JSON schema with required verdict fields", () => {
    expect(AGENT_VERDICT_JSON_SCHEMA.$id).toMatch(/agent-verdict/);
    expect(AGENT_VERDICT_JSON_SCHEMA.required).toEqual(
      expect.arrayContaining([
        "pick",
        "verdict",
        "reasons",
        "risks",
        "confidence",
        "unknowns",
        "serv_steps",
        "second_pass",
      ]),
    );
  });

  it("structures Find hops as decided → why → changed", () => {
    const log: FindDecisionLogEntry[] = [
      hop({
        hop: 1,
        action: "free_gov_recalls",
        evidenceAdded: ["No open park-it campaign for this model year."],
      }),
      hop({
        hop: 2,
        decidedBy: "SERV",
        invokeReason: "shortlist_changed",
        action: "compare_observed_asks",
        pickBefore: "a",
        pickAfter: "b",
        top5Before: [
          { key: "a", rank: 1 },
          { key: "b", rank: 2 },
        ],
        top5After: [
          { key: "b", rank: 1 },
          { key: "a", rank: 2 },
        ],
        evidenceAdded: ["The Accord ask sits closer to similar listings."],
      }),
    ];

    const verdict = buildAgentVerdictFromFind({
      pickKey: "b",
      pickLabel: "2019 Honda Accord",
      confidence: "medium",
      decisionLog: log,
      labels,
      vsCheapest: "The cheapest ask was not the best overall fit.",
      servCalls: 1,
      hadServStep: true,
    });
    expect(verdict.schemaVersion).toBe(AGENT_VERDICT_SCHEMA_VERSION);
    expect(verdict.no_serv_step).toBe(false);
    expect(verdict.serv_steps.length).toBeGreaterThanOrEqual(2);
    expect(verdict.serv_steps[0]?.decided).toMatch(/ran/i);
    expect(verdict.serv_steps[0]?.why).toMatch(/recall/i);
    expect(verdict.serv_steps[1]?.changed).toMatch(/pick changed/i);
    expect(verdict.vs_cheapest).toMatch(/cheapest/i);
  });

  it("shows multipath paths and reconciliation in the trail", () => {
    const multipath = reconcileMultipathDeterministic([
      {
        key: "a",
        label: "2020 Toyota Camry",
        askUsd: 18_000,
        riskScore: 2,
        totalCostUsd: 19_200,
        evidenceIds: ["ev_a_price"],
      },
      {
        key: "b",
        label: "2019 Honda Accord",
        askUsd: 16_500,
        riskScore: 1,
        totalCostUsd: 18_800,
        evidenceIds: ["ev_b_risk"],
      },
    ]);
    expect(multipath).not.toBeNull();
    expect(multipath!.paths).toHaveLength(3);
    const step = trailStepFromMultipath(multipath!);
    expect(step.decided).toMatch(/Price first/i);
    expect(step.why).toMatch(/close/i);
    expect(step.changed).toBeTruthy();
  });

  it("records a second-pass revision in the report trail", () => {
    const second = trailStepFromSecondPass({
      status: "disagreed",
      action: "pass",
      objection: "Open park-it campaign on this model year.",
      evidenceIds: ["ev_recall_open"],
      confidenceBefore: "high",
      confidenceAfter: "medium",
    });
    expect(second?.decided).toMatch(/disagreed/i);
    expect(second?.changed).toMatch(/Confidence lowered/i);

    const verdict = buildAgentVerdictFromReport({
      verdict: "buy",
      confidence: "medium",
      hadServStep: true,
      primaryNote: "Ask is under fair value with enough similar listings.",
      revised: {
        before: "buy",
        after: "Lemonless AI revised to negotiate after new similar-listing evidence.",
        why: "Two newer comps arrived with lower asks.",
      },
      secondPass: {
        status: "disagreed",
        action: "pass",
        objection: "Open park-it campaign on this model year.",
        evidenceIds: ["ev_recall_open"],
        confidenceBefore: "medium",
        confidenceAfter: "low",
      },
      servCalls: 2,
    });
    expect(verdict.no_serv_step).toBe(false);
    expect(
      verdict.serv_steps.some((step) => /revised/i.test(step.decided) || /revised/i.test(step.changed ?? "")),
    ).toBe(true);
    expect(verdict.second_pass?.status).toBe("disagreed");
    expect(verdict.confidence).toBe("low");
  });

  it("says plainly when a run had no agent step", () => {
    const verdict = buildAgentVerdictFromFind({
      pickKey: "a",
      pickLabel: "2020 Toyota Camry",
      confidence: "high",
      decisionLog: [hop({ hop: 1, action: "free_gov_fuel", evidenceAdded: ["Fuel estimate recorded."] })],
      labels,
      hadServStep: false,
    });
    expect(verdict.no_serv_step).toBe(true);
  });
});
