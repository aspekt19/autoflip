import { describe, expect, it } from "vitest";
import { applyResaleAgentGuardrails, validateResaleAgentVerdict } from "@/domain/resale-agent";
import { TtlCache } from "@/io/cache";
import { MemoryCounter } from "@/io/quota";
import type { Listing } from "@/domain/types";
import { isServChatCompletionsUrl, isServResponsesUrl } from "@/server/serv/agent-chat-turn";
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
        { vin: VIN, action: "negotiate", offerUsd: 15_500, why: "Fits." },
        { vin: "INVENTEDVIN000001", action: "buy", offerUsd: 10_000, why: "Invented." },
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
  it("tools mode: search injects flipPnl then finish → verdict", async () => {
    let responsesCalls = 0;
    let sawFlipPnl = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/listings")) {
        // Need a few comps so flip-rank can produce PnL.
        const peers = [
          listing({ priceUsd: 12_500 }),
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
          tools?: Array<{ name?: string }>;
          input?: string;
        };
        expect(body.tools?.some((t) => t.name === "search_listings")).toBe(true);
        expect(body.tools?.some((t) => t.name === "get_flip_pnl")).toBe(true);
        if (responsesCalls === 1) {
          return new Response(
            JSON.stringify({
              id: "resp_resale_1",
              output: [
                {
                  type: "function_call",
                  call_id: "call_search_1",
                  name: "search_listings",
                  arguments: JSON.stringify({
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
                  }),
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (String(body.input ?? "").includes("flipPnl")) sawFlipPnl = true;
        return new Response(
          JSON.stringify({
            id: "resp_resale_2",
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Ready." }] }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (!isServChatCompletionsUrl(url)) {
        return new Response("{}", { status: 404 });
      }
      return new Response(
        JSON.stringify({
          id: "chatcmpl-resale-finish",
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  summary: "Negotiate the Civic — code PnL looks positive.",
                  confidence: "high",
                  picks: [
                    {
                      vin: VIN,
                      action: "negotiate",
                      offerUsd: 15_800,
                      why: "Code flipPnl mid-profit clears target.",
                    },
                  ],
                  relaxedConditions: [{ name: "radius", why: "Opened to 100 miles for inventory." }],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
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
    expect(result.toolRounds).toBeGreaterThanOrEqual(1);
    expect(result.verdict.picks[0]?.vin).toBe(VIN);
    expect(sawFlipPnl).toBe(true);
    expect(result.pnlByVin.size).toBeGreaterThan(0);
    expect(responsesCalls).toBe(2);
  });

  it("next_action mode: search then finish", async () => {
    let servCalls = 0;
    let sawFlipPnl = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/listings")) {
        const peers = [
          listing({ priceUsd: 12_500 }),
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
                    radiusMi: 50,
                    fuel: null,
                    drivetrain: null,
                    sort: null,
                    limit: 10,
                    searchWhy: "Named model flip",
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
      const body = String(init?.body ?? "");
      if (body.includes("flipPnl") || body.includes("Tool result for search_listings")) {
        // messages include prior tool result with flipPnl
      }
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
                  summary: "Take the Civic as a negotiate.",
                  confidence: "medium",
                  picks: [
                    {
                      vin: VIN,
                      action: "negotiate",
                      offerUsd: 15_500,
                      why: "Asking near comps with code PnL.",
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

    // Intercept to detect PnL in the user message after search.
    const wrapped: typeof fetch = async (input, init) => {
      const url = String(input);
      if (isServChatCompletionsUrl(url) && servCalls >= 1) {
        const raw = String(init?.body ?? "");
        if (raw.includes("flipPnl")) sawFlipPnl = true;
      }
      return fetchImpl(input, init);
    };

    const result = await runResaleAgentLoop({
      note: "Civic flip near Austin",
      mode: "next_action",
      deps: {
        servKey: "test-serv",
        autodevKey: "test-autodev",
        fetch: wrapped,
        budgetUsd: 18_000,
        pnlOptions: { taxState: "TX" },
        autodev: { cache: new TtlCache<unknown>(), counter: new MemoryCounter() },
      },
      maxRounds: 10,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agentMode).toBe("next_action");
    expect(result.toolRounds).toBe(1);
    expect(result.verdict.picks[0]?.action).toBe("negotiate");
    expect(sawFlipPnl).toBe(true);
  });
});
