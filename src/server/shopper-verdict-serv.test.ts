import { describe, expect, it, vi } from "vitest";
import { ASSUMPTIONS } from "@/domain/assumptions";
import type { ComputedReport, Listing } from "@/domain/types";
import { runShopperVerdictServ } from "./shopper-verdict-serv";

function listing(partial: Partial<Listing> = {}): Listing {
  return {
    vin: "4T1KZ1AK4MU060006",
    year: 2021,
    make: "Toyota",
    model: "Camry",
    trim: "SE",
    miles: 32000,
    priceUsd: 23990,
    city: "Dallas",
    state: "TX",
    zip: "75201",
    dealer: null,
    vdp: null,
    primaryImage: null,
    carfaxUrl: null,
    used: true,
    cpo: false,
    accidentCount: 0,
    oneOwner: true,
    ownerCount: 1,
    usageType: "Personal",
    fuel: null,
    engine: null,
    drivetrain: null,
    bodyStyle: "Sedan",
    latitude: null,
    longitude: null,
    removedAt: null,
    source: "autodev",
    ...partial,
  };
}

function report(partial: Partial<ComputedReport> = {}): ComputedReport {
  const subject = listing();
  return {
    mode: "personal",
    subject,
    verdict: "fair",
    score: null,
    reasons: ["Ask near similar listings."],
    flags: [],
    questions: [],
    comps: [
      {
        vin: "4T1KZ1AK4MU060001",
        year: 2021,
        trim: "SE",
        miles: 30000,
        priceUsd: 24500,
        adjustedPriceUsd: 24200,
        city: null,
        state: null,
        distanceMiles: null,
      },
      {
        vin: "4T1KZ1AK4MU060002",
        year: 2020,
        trim: "SE",
        miles: 35000,
        priceUsd: 22900,
        adjustedPriceUsd: 23500,
        city: null,
        state: null,
        distanceMiles: null,
      },
      {
        vin: "4T1KZ1AK4MU060003",
        year: 2021,
        trim: "LE",
        miles: 28000,
        priceUsd: 25000,
        adjustedPriceUsd: 24800,
        city: null,
        state: null,
        distanceMiles: null,
      },
    ],
    compScope: "test",
    percentile: null,
    fairValueUsd: 24000,
    priceGap: (23990 - 24000) / 24000,
    mileage: {
      expectedMiles: null,
      subjectMiles: 32000,
      medianCompMiles: null,
      perMileUsd: null,
    },
    history: { multiplier: 1, lines: [] },
    recalls: [],
    recallsAvailable: true,
    openParkIt: false,
    complaintCount: 0,
    fuel: null,
    vinDecode: null,
    distanceToSearchZipMiles: null,
    flip: null,
    assumptions: { ...ASSUMPTIONS },
    dataNotes: ["Paid history was not run"],
    sample: false,
    ...partial,
  };
}

function jsonResponse(body: unknown, id: string) {
  return new Response(JSON.stringify({ id, model: "gpt-5.4-mini", choices: [{ message: { content: JSON.stringify(body) } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("runShopperVerdictServ", () => {
  it("skips SERV when no key and leaves no invented trail spend", async () => {
    const result = await runShopperVerdictServ({ report: report(), servKey: undefined });
    expect(result.agentVerdict.no_serv_step).toBe(true);
    expect(result.trace).toBeNull();
    expect(result.decideProof).toBeNull();
  });

  it("records a real decide + challenge trail when SERV succeeds", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse({ verdict: "negotiate", note: "Ask sits near fair value from the comps." }, "synthetic-test-decide-1");
      }
      return jsonResponse(
        {
          agrees: true,
          action: "negotiate",
          objection: null,
          evidenceIds: ["ev_fair_value"],
        },
        "synthetic-test-challenge-1",
      );
    });

    const result = await runShopperVerdictServ({
      report: report(),
      servKey: "test-key",
      model: "gpt-5.4-mini",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.agentVerdict.no_serv_step).toBe(false);
    expect(result.agentVerdict.verdict).toBe("negotiate");
    expect(result.agentVerdict.second_pass?.status).toMatch(/agreed|disagreed|ignored/);
    expect(result.trace?.calls.length).toBeGreaterThanOrEqual(1);
    expect(result.trace?.calls[0]?.rawResponse).toMatch(/negotiate/);
    // synthetic-test-* mock ids must never surface as provider response ids.
    expect(result.trace?.calls[0]?.responseId).toBeNull();
    expect(result.trace?.model).toBe("gpt-5.4-mini");
    expect(result.trace?.recordedAt).toMatch(/^\d{4}-/);
  });

  it("shows honest unavailable fallback when decide fails", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 503 }));
    const result = await runShopperVerdictServ({
      report: report(),
      servKey: "test-key",
      model: "gpt-5.4-mini",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.agentVerdict.no_serv_step).toBe(false);
    expect(result.agentVerdict.verdict).toBeNull();
    expect(result.agentVerdict.serv_steps[0]?.decided).toMatch(/failed/i);
    expect(result.agentVerdict.serv_steps[0]?.why).toBeTruthy();
    expect(result.agentVerdict.second_pass?.status).toBe("not_run");
    expect(result.agentVerdict.unknowns?.[0]).toMatch(/Agent step failed/i);
    expect(result.agentVerdict.serv_spend?.costNote).toMatch(/Agent step failed/i);
    expect(result.proofRecords.some((row) => row.purpose === "verdict_decide" && row.status === "failed")).toBe(
      true,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.trace?.calls).toHaveLength(1);
    expect(result.trace?.calls[0]?.profile).toBe("verdict_decide");
    expect(result.trace?.calls[0]?.rawResponse).toBeNull();
  });

  it("clamps a SERV buy when title-brand gates forbid buy and negotiate", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ verdict: "buy", note: "Looks fine." }, "synthetic-test-buy"),
    );
    const result = await runShopperVerdictServ({
      report: report({
        flags: [{ level: "stop", text: "Salvage title.", source: "title-brand" }],
      }),
      servKey: "test-key",
      model: "gpt-5.4-mini",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.decision.servChoice).toBe("buy");
    expect(result.decision.finalAction).not.toBe("buy");
    expect(result.decision.finalAction).not.toBe("negotiate");
    expect(result.agentVerdict.verdict).not.toBe("buy");
    expect(result.agentVerdict.serv_steps[0]?.why).toBe("Looks fine.");
    expect(result.agentVerdict.serv_steps[0]?.changed).toMatch(/gates kept/);
    const init = (fetchImpl.mock.calls as unknown as Array<[unknown, RequestInit]>)[0]?.[1];
    const sent = JSON.parse(String(init?.body)) as { messages?: Array<{ role?: string; content?: string }> };
    const user = sent.messages?.find((message) => message.role === "user")?.content ?? "";
    const facts = JSON.parse(user) as { facts?: { allowedActions?: string[] } };
    expect(facts.facts?.allowedActions).not.toContain("buy");
    expect(facts.facts?.allowedActions).not.toContain("negotiate");
  });

  it("re-clamps verdict_challenge after decide and skips when remaining budget is short", async () => {
    const { makeResaleDeadline, RESALE_TIME_BUDGET_SKIP } = await import("@/domain/resale-deadline");
    // 5s total: decide burns ~2.5s → remaining below challenge's useful minimum.
    const deadline = makeResaleDeadline(5_000);
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        await new Promise((r) => setTimeout(r, 2_500));
        return jsonResponse(
          { verdict: "negotiate", note: "Ask sits near fair value from the comps." },
          "synthetic-test-decide-budget",
        );
      }
      throw new Error("challenge must not run when re-clamp skips");
    });

    const result = await runShopperVerdictServ({
      report: report(),
      servKey: "test-key",
      model: "gpt-5.4-mini",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      deadline,
      decideTimeoutMs: 3_500,
      transportPolicy: "experiment_single_attempt",
    });

    expect(calls).toBe(1);
    expect(result.steps.some((s) => s.id === "serv_verdict_challenge" && s.status === "skipped_time_budget")).toBe(
      true,
    );
    expect(result.agentVerdict.second_pass?.objection).toBe(RESALE_TIME_BUDGET_SKIP);
    expect(result.trace?.calls.every((c) => c.profile !== "verdict_challenge")).toBe(true);
  });

  it("withholds without inventing SERV when asking price is missing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network should not be called when gates withhold");
    });
    const result = await runShopperVerdictServ({
      report: report({ subject: listing({ priceUsd: null }), verdict: "insufficient_data", fairValueUsd: null }),
      servKey: "test-key",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.decision.gateRun.withheld).toBe(true);
    expect(result.trace).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(
      result.steps.some(
        (s) => s.id === "serv_verdict_challenge" && s.status === "skipped_withheld",
      ),
    ).toBe(true);
  });

  it("journals challenge skip when decide returns no usable choice", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 503 }));
    const result = await runShopperVerdictServ({
      report: report(),
      servKey: "test-key",
      model: "gpt-5.4-mini",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      transportPolicy: "experiment_single_attempt",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const challenge = result.steps.find((s) => s.id === "serv_verdict_challenge");
    expect(challenge?.status).toBe("skipped_no_choice");
    expect(challenge?.detail).toMatch(/no usable choice/i);
  });

  it("applies a valid challenge disagreement as finalAction under guardrails", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(
          { verdict: "buy", note: "Ask looks strong versus comps." },
          "synthetic-test-decide-buy",
        );
      }
      return jsonResponse(
        {
          agrees: false,
          action: "pass",
          objection: "Accident history note and thin comps make buy too aggressive.",
          evidenceIds: ["ev_fair_value", "ev_note_0"],
        },
        "synthetic-test-challenge-pass",
      );
    });

    const result = await runShopperVerdictServ({
      report: report(),
      servKey: "test-key",
      model: "gpt-5.4-mini",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.agentVerdict.second_pass?.status).toBe("disagreed");
    expect(result.decision.finalAction).toBe("pass");
    expect(result.agentVerdict.verdict).toBe("pass");
    expect(result.agentVerdict.serv_steps.some((step) => /changed the verdict to pass/i.test(step.decided))).toBe(
      true,
    );
    const challengeProof = result.proofRecords.find((row) => row.purpose === "verdict_challenge");
    expect(challengeProof?.rawResponse).toMatch(/Accident history/);
    expect(challengeProof?.verdict).toBe("pass");
    const decideProof = result.proofRecords.find((row) => row.purpose === "verdict_decide");
    expect(decideProof?.rawResponse).toMatch(/buy/);
  });

  it("keeps guardrail clamp when challenge wants a forbidden action", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse({ verdict: "pass", note: "Title risk." }, "synthetic-test-decide-pass");
      }
      return jsonResponse(
        {
          agrees: false,
          action: "buy",
          objection: "Still want buy despite title brand.",
          evidenceIds: ["ev_flag_0"],
        },
        "synthetic-test-challenge-buy",
      );
    });

    const result = await runShopperVerdictServ({
      report: report({
        flags: [{ level: "stop", text: "Salvage title.", source: "title-brand" }],
        dataNotes: ["Title brand stop."],
      }),
      servKey: "test-key",
      model: "gpt-5.4-mini",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.agentVerdict.second_pass?.status).toBe("disagreed");
    // buy is not in allowedActions for salvage — challenge must not become finalAction.
    expect(result.decision.finalAction).not.toBe("buy");
    expect(result.decision.allowedActions).not.toContain("buy");
  });

  it("skips challenge for call cap when only one slot remains", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls > 1) throw new Error("challenge must not run when only one SERV slot remains");
      return jsonResponse(
        { verdict: "negotiate", note: "Ask sits near fair value from the comps." },
        "synthetic-test-decide-cap",
      );
    });
    const result = await runShopperVerdictServ({
      report: report(),
      servKey: "test-key",
      model: "gpt-5.4-mini",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxAdditionalServCalls: 1,
      transportPolicy: "experiment_single_attempt",
    });
    expect(calls).toBe(1);
    expect(
      result.steps.some(
        (s) => s.id === "serv_verdict_challenge" && s.status === "skipped_call_cap",
      ),
    ).toBe(true);
  });
});
