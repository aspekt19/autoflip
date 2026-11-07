import { describe, expect, it } from "vitest";
import { requestFor, runServ } from "@/server/serv";
import { parseScoutPlanText } from "./plan-parse";
import { servScoutPlanner } from "./planner";

describe("scout_plan transport contracts (offline)", () => {
  it("requestFor(scout_plan) puts guard in tools[] and schema in response_format — not user-text theater", () => {
    const req = requestFor("scout_plan", JSON.stringify({ pendingVins: ["X"] }));
    expect(req.endpoint).toBe("chat");
    expect(req.stream).toBe(false);
    expect(req.model).toBe("gpt-5.4-mini"); // no multipath/kronos suffix by default
    expect(req.model).not.toMatch(/serv-multipath|serv-kronos/);

    const toolNames = (req.tools ?? []).map((t) =>
      t.function?.name ?? t.name ?? "",
    );
    expect(toolNames).toContain("serv_prompt_guard");
    expect(toolNames).not.toContain("serv_disable_content_filter");
    expect(toolNames).not.toContain("serv_shadow_agent"); // default-off until measured

    const rf = (req as { response_format?: { json_schema?: { name?: string; schema?: { properties?: { type?: { enum?: string[] } } } } } })
      .response_format;
    expect(rf?.json_schema?.name).toBe("lemonless_scout_plan_action");
    expect(rf?.json_schema?.schema?.properties?.type?.enum).toContain("select_candidate");
    expect(rf?.json_schema?.schema?.properties?.type?.enum).not.toContain("alert");

    const system = (req as { messages?: Array<{ role: string; content: string }> }).messages?.find(
      (m) => m.role === "system",
    )?.content;
    expect(system).toBeTruthy();
    // Policy in system; must not pretend markers are prose-enabled
    expect(system).not.toMatch(/serv_prompt_guard|serv_shadow_agent|multipath|kronos/i);
  });

  it("mocked HTTP transport uses scout_plan body and parses allowlisted action", async () => {
    const bodies: unknown[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  type: "abstain",
                  reason: "insufficient evidence",
                  servStepId: "t1",
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const result = await runServ(
      "scout_plan",
      { user: JSON.stringify({ pendingVins: [] }) },
      // Fake base — contract asserts request body shape via mocked fetch, not live SERV.
      { fetch: fetchImpl, apiKey: "test-key", baseUrl: "https://serv-mock.test/v1" },
    );
    expect(result.ok).toBe(true);
    expect(bodies).toHaveLength(1);
    const body = bodies[0] as {
      model: string;
      tools: Array<{ function?: { name: string }; name?: string }>;
      response_format?: { json_schema?: { name: string } };
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe("gpt-5.4-mini");
    expect(body.tools.some((t) => (t.function?.name ?? t.name) === "serv_prompt_guard")).toBe(true);
    expect(body.response_format?.json_schema?.name).toBe("lemonless_scout_plan_action");
    expect(body.messages[0]?.role).toBe("system");
    if (result.ok) {
      const parsed = parseScoutPlanText(result.text);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.action.type).toBe("abstain");
    }
  });

  it("servScoutPlanner stays fail-closed without verified paid authorization (no silent autonomy)", async () => {
    const planner = servScoutPlanner({ apiKey: "x" });
    const out = await planner({
      mandate: {
        mode: "flip",
        budgetUsd: null,
        budgetKnown: false,
        targetProfitUsd: 500,
        repairAbility: "unknown",
        preferredMakes: ["Toyota"],
        openToOtherMakes: false,
        zip: "72712",
        maxDistanceMiles: 100,
        maxMiles: null,
        notes: null,
      },
      pool: [],
      pendingVins: [],
      investigated: [],
      rejected: [],
      step: 1,
      recentOutcomes: [],
      evidenceContext: {
        evidenceBriefs: [],
        newlyAcquiredVins: [],
        searchHistory: [],
        budgetsRemaining: { servCalls: 0, toolCalls: 0, providerCalls: 0 },
        recentOutcomes: [],
        policy: { unsupportedGovAloneDoesNotProveCarBad: true },
      },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe("serv_unavailable");
  });

  it("flip_judge schema is not a valid scout plan (regression)", () => {
    const flipShaped = JSON.stringify({
      decisions: [{ vin: "X", verdict: "alert", note: "looks good" }],
    });
    const parsed = parseScoutPlanText(flipShaped);
    expect(parsed.ok).toBe(false);
  });
});
