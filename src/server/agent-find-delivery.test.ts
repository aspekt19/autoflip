/**
 * API v1 / MCP Find must not charge when match ok but zero cars delivered.
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
    directions: [
      {
        id: "empty-sedans",
        segment: "Empty sedans",
        why: "synthetic-test-zero-cars",
        guidance: "editorial",
        yearMin: 1990,
        yearMax: 2027,
        yearBecause: "No year range in your note — searching without a budget-invented year ceiling.",
        models: [{ make: "Toyota", model: "Corolla" }],
        search: { make: "Toyota", model: "Corolla" },
        bodyStyle: "Sedan",
      },
    ],
    followUps: [],
    guard: "allow",
    checks: [],
    criteriaParse: { source: "code", responseId: null, label: "code" },
    proofRecords: [],
  })),
}));

vi.mock("@/server/find-match", async () => {
  const actual = await vi.importActual<typeof import("@/server/find-match")>("@/server/find-match");
  return {
    ...actual,
    runFindMatch: vi.fn(async () => ({
      ok: true,
      status: 200,
      body: {
        ok: true,
        sample: false,
        emptyReason: "empty_inventory",
        message: "No listings came back for that search.",
        headline: "No cars found",
        nextStep: "Widen the search.",
        scope: "Nationwide",
        affordabilityAssessed: true,
        partialFailure: false,
        geoScope: { zip: null, distanceMiles: null },
        directions: [
          {
            direction: {
              id: "empty-sedans",
              segment: "Empty sedans",
              why: "synthetic-test-zero-cars",
              guidance: "editorial",
              yearMin: 1990,
              yearMax: 2027,
              yearBecause: "test",
              models: [{ make: "Toyota", model: "Corolla" }],
              search: { make: "Toyota", model: "Corolla" },
            },
            listings: [],
            plannedModels: [{ make: "Toyota", model: "Corolla" }],
            searchedModels: [{ make: "Toyota", model: "Corolla" }],
            failedModels: [],
            skippedModels: [],
            coverage: "empty",
            coverageLevel: "low",
            note: null,
            providerWarning: null,
            queryOutcomes: [
              { make: "Toyota", model: "Corolla", outcome: "empty", message: null },
            ],
          },
        ],
        compsPool: [],
        providerQueriesUsed: 1,
      },
    })),
  };
});

describe("advanceAgentFindRun zero-car charge gate", () => {

  it("completes with credit_spent false when match ok but zero cars", async () => {
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
