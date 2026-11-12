/**
 * API v1 / MCP Find must not charge when SERV settles with no chosen car.
 */
import { describe, expect, it, vi } from "vitest";
import { creditBalance, creditGrant } from "@/io/credit-book";
import { getKv } from "@/io/kv";
import { createApiKey } from "@/server/api-keys";
import { authenticateAgentRequest } from "@/server/agent-auth";
import { advanceAgentFindRun, createAgentFindRun } from "@/server/agent-find";

vi.mock("@/server/understand-need", () => ({
  understandNeed: vi.fn(async () => ({
    ok: true,
    source: "form",
    need: {
      mode: "personal",
      note: "synthetic-test-zero-cars",
      budgetUsd: 15_000,
      budgetKnown: true,
      budgetScope: "unspecified",
      zip: "78701",
      distanceMiles: null,
      milesMax: null,
      yearMin: null,
      yearMax: null,
      useCase: "unspecified",
      mustHaves: [],
      priorities: [],
      preferredMakes: [],
      preferredModels: [],
      preferredModelsSource: "none",
      openToOtherMakes: true,
      make: null,
      repairAbility: "unknown",
      targetProfitUsd: null,
      yearBandResolved: false,
      milesCapResolved: false,
      conditionPriority: "unspecified",
      awdPreference: false,
      reliabilityPriority: false,
      fuelEconomyPriority: false,
      bodyStyle: null,
      locationPhrase: null,
    },
    findPlan: {
      summary: "synthetic-test-zero-cars",
      bodyStyles: ["sedan"],
      budget: { maxUsd: 15_000, approximate: false, quote: null },
      yearMin: null,
      yearMax: null,
      milesMax: null,
      drivetrain: { value: "any", strength: "none", quote: null },
      fuel: { value: "any", strength: "none", quote: null },
      seatsMin: null,
      location: { zip: "78701", phrase: null, needsZip: false },
      priorities: [],
      namedModels: [],
      excludedMakes: [],
      question: { id: "none", text: null },
      directions: [
        {
          label: "Empty sedans",
          why: "synthetic-test-zero-cars",
          bodyStyle: "sedan",
          models: [{ make: "Toyota", model: "Corolla" }],
        },
      ],
    },
    directions: [],
    followUps: [],
    guard: "allow",
    checks: [],
    criteriaParse: { source: "code", responseId: null, label: "code" },
    proofRecords: [],
  })),
}));

vi.mock("@/server/find-decide-orchestrator", () => ({
  runFindDecideOrchestrator: vi.fn(async () => ({
    ok: true,
    status: 200,
    searchContextToken: "synthetic-token",
    bestDeal: null,
    pickAgentVerdict: {
      pick: null,
      verdict: null,
      confidence: null,
      reasons: [],
      unknowns: ["nothing_fits"],
      serv_steps: [
        {
          decided: "Nothing fits",
          why: "No listings matched after SERV search.",
          changed: null,
          evidenceIds: ["find_agent_loop"],
        },
      ],
      no_serv_step: false,
      serv_spend: { calls: 1, costNote: null },
    },
    pickSecondPass: {
      status: "not_run",
      action: null,
      objection: null,
      evidenceIds: [],
      confidenceBefore: null,
      confidenceAfter: null,
    },
    pickProofRecords: [],
    freeGovReceipts: [],
    freeGovCoverage: { note: "", anyUnchecked: false },
    riskCoverage: { note: "" },
    freeEvidenceNote: "",
    triageSource: "SERV",
    decideSource: "SERV",
    shortlistKeys: [],
    loop: { continue: false, reason: "decide_settled", detail: "Nothing fits." },
    honesty: "SERV agent loop found nothing that fits.",
    needAfter: null,
    appliedCheckIds: [],
    decisionLog: [],
    carChecks: [],
    replay: false,
    offerPool: [],
    agentLoop: {
      agentMode: "find",
      toolRounds: 1,
      // Incomplete empty search — not a documented nothing-fits; must not charge.
      verdictReached: false,
      relaxedConditions: [],
      journalServCalls: 1,
      journalToolCalls: 1,
      carsFound: 0,
      passReason: null,
    },
  })),
}));

describe("advanceAgentFindRun zero-car charge gate", () => {
  it("completes with credit_spent false when SERV finds no cars", async () => {
    const kv = getKv();
    await creditGrant(kv, "agent-zero-user", 3, "seed-zero");
    const created = await createApiKey(kv, "agent-zero-user", "Zero", ["find", "read"]);
    const auth = await authenticateAgentRequest(
      kv,
      new Request("http://localhost/api/v1/find", {
        headers: { authorization: `Bearer ${created.token}` },
      }),
      "http://localhost",
      "find",
    );
    expect(auth.ok).toBe(true);
    if (!auth.ok) return;

    const createdRun = await createAgentFindRun(
      auth.caller,
      { text: "synthetic-test-zero-cars under 15000", idempotencyKey: "zero-cars-1" },
      { kv, origin: "http://localhost" },
    );
    expect(createdRun.ok).toBe(true);
    if (!createdRun.ok) return;

    const advanced = await advanceAgentFindRun(createdRun.run.run_id, {
      kv,
      origin: "http://localhost",
    });
    expect(advanced?.status).toBe("completed");
    expect(advanced?.result?.credit_spent).toBe(false);
    expect(advanced?.result?.credits).toBe(0);
    expect(await creditBalance(kv, "agent-zero-user")).toBe(3);
  });
});
