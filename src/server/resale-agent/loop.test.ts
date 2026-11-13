import { describe, expect, it } from "vitest";
import { applyResaleAgentGuardrails, validateResaleAgentVerdict } from "@/domain/resale-agent";
import { TtlCache } from "@/io/cache";
import { MemoryCounter } from "@/io/quota";
import type { Listing } from "@/domain/types";
import { isServChatCompletionsUrl, isServResponsesUrl } from "@/server/serv/agent-chat-turn";
import { BASE_MODEL } from "@/server/serv";
import { runResaleAgentLoop } from "./loop";

const VIN = "JTMRWRFV0KJ123456";

function listing(partial?: Partial<Listing>): Listing {
  return {
    vin: VIN,
    year: 2020,
    make: "Honda",
    model: "Civic",
    trim: "EX",
    miles: 38000,
    priceUsd: 16_500,
    city: "Austin",
    state: "TX",
    zip: "78701",
    dealer: "Test Dealer",
    vdp: "https://example.com/vdp",
    primaryImage: null,
    carfaxUrl: null,
    used: true,
    cpo: false,
    accidentCount: 0,
    oneOwner: true,
    ownerCount: 1,
    usageType: null,
    fuel: "Gasoline",
    engine: null,
    drivetrain: "FWD",
    bodyStyle: "Sedan",
    latitude: null,
    longitude: null,
    removedAt: null,
    source: "autodev",
    ...partial,
  };
}

function autodevListingsPayload(rows: Listing[]) {
  return {
    data: rows.map((row) => ({
      vin: row.vin,
      vehicle: {
        year: row.year,
        make: row.make,
        model: row.model,
        trim: row.trim,
        fuel: row.fuel,
        drivetrain: row.drivetrain,
        bodyStyle: row.bodyStyle,
      },
      retailListing: {
        price: row.priceUsd,
        miles: row.miles,
        used: true,
        vdp: row.vdp,
      },
      dealer: { name: row.dealer, city: row.city, state: row.state, zip: row.zip },
    })),
  };
}

describe("resale-agent guardrails (domain)", () => {
  it("drops invented VINs", () => {
    const validated = validateResaleAgentVerdict({
      summary: "Pick the Civic.",
      confidence: "medium",
      picks: [
        { vin: VIN, action: "negotiate", offerUsd: 15_500, why: "Fits.", riskNotes: null },
        {
          vin: "INVENTEDVIN000001",
          action: "buy",
          offerUsd: 10_000,
          why: "Invented.",
          riskNotes: null,
        },
      ],
      relaxedConditions: [],
    });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const guarded = applyResaleAgentGuardrails(validated.verdict, {
      allowedVins: new Set([VIN]),
      budgetUsd: 18_000,
    });
    expect(guarded.dropped.some((d) => d.reason === "invented_vin_not_in_tool_results")).toBe(true);
    expect(guarded.verdict.picks).toHaveLength(1);
  });
});

describe("runResaleAgentLoop", () => {
  it("tools mode: search injects flipPnl then submit_picks → verdict", async () => {
    let responsesCalls = 0;
    let sawFlipPnl = false;
    let sawReasoningEcho = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/zip/")) {
        const zip = url.split("/zip/")[1]?.slice(0, 5) || "00000";
        return new Response(
          JSON.stringify({
            success: true,
            payload: { zip, city: "Test", state: "FL", latitude: 25.7, longitude: -80.2 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/listings")) {
        // Cheap ask on the target VIN vs higher comps → positive code mid-profit.
        const peers = [
          listing({ priceUsd: 11_500, miles: 42000 }),
          listing({ vin: "JTMRWRFV0KJ123457", priceUsd: 17_200, miles: 40000 }),
          listing({ vin: "JTMRWRFV0KJ123458", priceUsd: 17_800, miles: 36000 }),
          listing({ vin: "JTMRWRFV0KJ123459", priceUsd: 16_900, miles: 41000 }),
          listing({ vin: "JTMRWRFV0KJ123460", priceUsd: 18_100, miles: 39000 }),
          listing({ vin: "JTMRWRFV0KJ123461", priceUsd: 17_400, miles: 37000 }),
          listing({ vin: "JTMRWRFV0KJ123462", priceUsd: 16_800, miles: 42000 }),
        ];
        return new Response(JSON.stringify(autodevListingsPayload(peers)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (isServResponsesUrl(url)) {
        responsesCalls += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          model?: string;
          tools?: Array<{ name?: string }>;
          instructions?: string;
          input?: unknown;
          max_output_tokens?: number;
        };
        expect(typeof body.instructions).toBe("string");
        expect(body.instructions).not.toMatch(/Shopper note:/i);
        expect(body.tools?.some((t) => t.name === "search_listings")).toBe(true);
        expect(body.tools?.some((t) => t.name === "get_flip_pnl")).toBe(true);
        expect(body.tools?.some((t) => t.name === "submit_picks")).toBe(true);
        expect(Array.isArray(body.input)).toBe(true);
        expect(typeof body.max_output_tokens).toBe("number");

        if (responsesCalls === 1) {
          expect(body.model).toBe(BASE_MODEL);
          expect(body.tools?.map((t) => t.name)[0]).toBe("serv_prompt_guard");
          expect(body.tools?.some((t) => t.name === "serv_shadow_agent")).toBe(false);
          return new Response(
            JSON.stringify({
              id: "resp_resale_1",
              output: [
                { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Search Civic." }] },
                {
                  type: "function_call",
                  id: "fc_1",
                  call_id: "call_search_1",
                  name: "search_listings",
                  arguments: JSON.stringify({
                    make: "Honda",
                    model: "Civic",
                    bodyStyle: null,
                    bodyFamily: "car",
                    priceMaxUsd: 18000,
                    milesMax: 60000,
                    yearMin: 2018,
                    yearMax: 2022,
                    zip: "78701",
                    radiusMi: 100,
                    transmission: null,
                    fuel: null,
                    drivetrain: null,
                    sort: null,
                    limit: 10,
                  }),
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        const inputItems = body.input as Array<Record<string, unknown>>;
        if (inputItems.some((item) => item.type === "reasoning")) sawReasoningEcho = true;
        const blob = JSON.stringify(inputItems);
        if (blob.includes("flipPnl")) sawFlipPnl = true;

        if (responsesCalls === 2) {
          // Still search step after listings — terminal deferred to selection hop.
          expect(body.model).toBe(BASE_MODEL);
          expect(body.tools?.some((t) => t.name === "serv_shadow_agent")).toBe(false);
          return new Response(
            JSON.stringify({
              id: "resp_resale_2",
              output: [
                {
                  type: "function_call",
                  call_id: "call_submit_early",
                  name: "submit_picks",
                  arguments: JSON.stringify({
                    summary: "Negotiate the Civic — code PnL looks positive.",
                    confidence: "high",
                    picks: [
                      {
                        vin: VIN,
                        action: "negotiate",
                        offerUsd: 11_000,
                        why: "Code flipPnl mid-profit clears target.",
                        riskNotes: null,
                      },
                    ],
                    relaxedConditions: [{ name: "radius", why: "Opened to 100 miles for inventory." }],
                  }),
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        // Selection hop uses multipath+shadow; evidence-repair hop is bare + tool_choice required.
        const selection = body.model === `${BASE_MODEL}-serv-multipath`;
        if (selection) {
          expect(body.tools?.map((t) => t.name)[0]).toBe("serv_shadow_agent");
          expect(body.tools?.some((t) => t.name === "serv_prompt_guard")).toBe(false);
        } else {
          expect(body.model).toBe(BASE_MODEL);
        }
        return new Response(
          JSON.stringify({
            id: `resp_resale_${responsesCalls}`,
            output: [
              {
                type: "function_call",
                call_id: `call_submit_${responsesCalls}`,
                name: "submit_picks",
                arguments: JSON.stringify({
                  summary: "Negotiate the Civic — code PnL looks positive.",
                  confidence: "high",
                  picks: [
                    {
                      vin: VIN,
                      action: "negotiate",
                      offerUsd: 11_000,
                      why: "Code flipPnl mid-profit clears target.",
                      riskNotes: "Days on market unknown — verify with seller.",
                    },
                  ],
                  relaxedConditions: [{ name: "radius", why: "Opened to 100 miles for inventory." }],
                }),
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (isServChatCompletionsUrl(url)) {
        return new Response("{}", { status: 500 });
      }
      return new Response("{}", { status: 404 });
    };

    const result = await runResaleAgentLoop({
      note: "Honda Civic flip under $18k near Austin",
      mode: "tools",
      deps: {
        servKey: "test-serv",
        autodevKey: "test-autodev",
        fetch: fetchImpl,
        budgetUsd: 18_000,
        pnlOptions: { taxState: "TX", repairAbility: "unknown" },
        autodev: { cache: new TtlCache<unknown>(), counter: new MemoryCounter() },
      },
      maxRounds: 10,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agentMode).toBe("tools");
    expect(result.toolRounds).toBeGreaterThanOrEqual(2);
    expect(result.verdict.picks[0]?.vin).toBe(VIN);
    expect(sawFlipPnl).toBe(true);
    expect(sawReasoningEcho).toBe(true);
    expect(result.pnlByVin.size).toBeGreaterThan(0);
    expect(responsesCalls).toBeGreaterThanOrEqual(3);
    expect(result.servFeatures.features).toEqual(
      expect.arrayContaining(["serv_shadow_agent", "multipath"]),
    );
    expect(result.servFeatures.features).not.toContain("serv_prompt_guard");
    expect(result.featureFlags).toEqual([]);
  });

  it("next_action mode: search then finish", async () => {
    let servCalls = 0;
    let sawFlipPnl = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/zip/")) {
        const zip = url.split("/zip/")[1]?.slice(0, 5) || "00000";
        return new Response(
          JSON.stringify({
            success: true,
            payload: { zip, city: "Test", state: "FL", latitude: 25.7, longitude: -80.2 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/listings")) {
        const peers = [
          // Asking must be ≥ finish offerUsd (15500) for submit_picks validation.
          listing({ priceUsd: 9_500 }),
          listing({ vin: "JTMRWRFV0KJ123457", priceUsd: 17_200, miles: 40000 }),
          listing({ vin: "JTMRWRFV0KJ123458", priceUsd: 17_800, miles: 36000 }),
          listing({ vin: "JTMRWRFV0KJ123459", priceUsd: 16_900, miles: 41000 }),
          listing({ vin: "JTMRWRFV0KJ123460", priceUsd: 18_100, miles: 39000 }),
          listing({ vin: "JTMRWRFV0KJ123461", priceUsd: 17_400, miles: 37000 }),
          listing({ vin: "JTMRWRFV0KJ123462", priceUsd: 16_800, miles: 42000 }),
        ];
        return new Response(JSON.stringify(autodevListingsPayload(peers)), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (!isServChatCompletionsUrl(url)) {
        return new Response("{}", { status: 404 });
      }
      servCalls += 1;
      if (servCalls === 1) {
        return new Response(
          JSON.stringify({
            id: "chatcmpl-na-1",
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: JSON.stringify({
                    action: "search",
                    make: "Honda",
                    model: "Civic",
                    bodyStyle: null,
                    priceMaxUsd: 18000,
                    milesMax: 60000,
                    yearMin: 2018,
                    yearMax: 2022,
                    zip: "78701",
                    radiusMi: 100,
                    fuel: null,
                    drivetrain: null,
                    sort: null,
                    limit: 10,
                    searchWhy: "Named model",
                    summary: null,
                    confidence: null,
                    picks: null,
                    relaxedConditions: null,
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: Array<{ content?: string }>;
      };
      const last = body.messages?.[body.messages.length - 1]?.content ?? "";
      if (last.includes("flipPnl")) sawFlipPnl = true;
      return new Response(
        JSON.stringify({
          id: "chatcmpl-na-2",
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  action: "finish",
                  make: null,
                  model: null,
                  bodyStyle: null,
                  priceMaxUsd: null,
                  milesMax: null,
                  yearMin: null,
                  yearMax: null,
                  zip: null,
                  radiusMi: null,
                  fuel: null,
                  drivetrain: null,
                  sort: null,
                  limit: null,
                  searchWhy: null,
                  summary: "Negotiate the Civic.",
                  confidence: "medium",
                  picks: [
                    {
                      vin: VIN,
                      action: "negotiate",
                      offerUsd: 9_000,
                      why: "Code PnL.",
                      riskNotes: null,
                    },
                  ],
                  relaxedConditions: [],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const result = await runResaleAgentLoop({
      note: "Civic flip",
      mode: "next_action",
      deps: {
        servKey: "test-serv",
        autodevKey: "test-autodev",
        fetch: fetchImpl,
        budgetUsd: 18_000,
        pnlOptions: { taxState: "TX", repairAbility: "unknown" },
        autodev: { cache: new TtlCache<unknown>(), counter: new MemoryCounter() },
      },
      maxRounds: 10,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agentMode).toBe("next_action");
    expect(result.toolRounds).toBe(1);
    expect(sawFlipPnl).toBe(true);
    expect(result.verdict.picks[0]?.action).toBe("negotiate");
  });
});
