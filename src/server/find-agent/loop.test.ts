import { describe, expect, it } from "vitest";
import { applyFindAgentGuardrails, validateFindAgentVerdict } from "@/domain/find-agent";
import { TtlCache } from "@/io/cache";
import { MemoryCounter } from "@/io/quota";
import type { Listing } from "@/domain/types";
import { runFindAgentLoop } from "./loop";

const VIN = "JTMRWRFV0KJ123456";

function listing(partial?: Partial<Listing>): Listing {
  return {
    vin: VIN,
    year: 2021,
    make: "Toyota",
    model: "RAV4",
    trim: "XLE",
    miles: 42000,
    priceUsd: 24_500,
    city: "Miami",
    state: "FL",
    zip: "33101",
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
    drivetrain: "AWD",
    bodyStyle: "SUV",
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

describe("find-agent guardrails", () => {
  it("drops invented VINs and clamps offer to budget", () => {
    const validated = validateFindAgentVerdict({
      summary: "Pick the RAV4.",
      confidence: "medium",
      picks: [
        {
          vin: VIN,
          label: "2021 Toyota RAV4",
          action: "negotiate",
          offerUsd: 30_000,
          why: "Fits.",
        },
        {
          vin: "INVENTEDVIN000001",
          label: "Fake",
          action: "buy",
          offerUsd: 10_000,
          why: "Invented.",
        },
      ],
      relaxedConditions: [],
      passReason: null,
    });
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const guarded = applyFindAgentGuardrails(validated.verdict, {
      allowedVins: new Set([VIN]),
      budgetUsd: 25_000,
    });
    expect(guarded.dropped.some((d) => d.reason === "invented_vin_not_in_tool_results")).toBe(true);
    expect(guarded.verdict.picks).toHaveLength(1);
    expect(guarded.verdict.picks[0]?.offerUsd).toBe(25_000);
  });
});

describe("runFindAgentLoop", () => {
  it("tools mode: one tool_calls round then finish JSON → verdict", async () => {
    let servCalls = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/listings")) {
        return new Response(JSON.stringify(autodevListingsPayload([listing()])), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (!url.includes("/chat/completions")) {
        return new Response("{}", { status: 404 });
      }
      servCalls += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        tools?: unknown[];
        response_format?: { json_schema?: { name?: string } };
        messages?: Array<{ role?: string }>;
      };
      if (servCalls === 1 && Array.isArray(body.tools) && body.tools.length > 0) {
        return new Response(
          JSON.stringify({
            id: "chatcmpl-tools-1",
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: "call_search_1",
                      type: "function",
                      function: {
                        name: "search_listings",
                        arguments: JSON.stringify({
                          make: "Toyota",
                          model: "RAV4",
                          bodyStyle: null,
                          priceMaxUsd: 26000,
                          milesMax: 60000,
                          yearMin: 2019,
                          yearMax: 2022,
                          zip: "33101",
                          radiusMi: 100,
                          fuel: null,
                          drivetrain: null,
                          sort: null,
                          limit: 10,
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // Finish / repair structured turns
      return new Response(
        JSON.stringify({
          id: "chatcmpl-finish-1",
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  summary: "Buy the RAV4 in budget.",
                  confidence: "high",
                  picks: [
                    {
                      vin: VIN,
                      label: "2021 Toyota RAV4",
                      action: "buy",
                      offerUsd: 24_000,
                      why: "Clean asking price under budget.",
                    },
                  ],
                  relaxedConditions: [{ name: "radius", why: "Opened to 100 miles for inventory." }],
                  passReason: null,
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const result = await runFindAgentLoop({
      note: "Toyota RAV4 under $26k near Miami",
      mode: "tools",
      deps: {
        servKey: "test-serv",
        autodevKey: "test-autodev",
        fetch: fetchImpl,
        budgetUsd: 26_000,
        autodev: { cache: new TtlCache<unknown>(), counter: new MemoryCounter() },
      },
      maxRounds: 10,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agentMode).toBe("tools");
    expect(result.toolRounds).toBeGreaterThanOrEqual(1);
    expect(result.verdict.picks[0]?.vin).toBe(VIN);
    expect(result.relaxedConditions[0]?.name).toBe("radius");
  });

  it("next_action mode: search then finish", async () => {
    let servCalls = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/listings")) {
        return new Response(JSON.stringify(autodevListingsPayload([listing()])), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (!url.includes("/chat/completions")) {
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
                    make: "Toyota",
                    model: "RAV4",
                    bodyStyle: null,
                    priceMaxUsd: 26000,
                    milesMax: 60000,
                    yearMin: 2019,
                    yearMax: 2022,
                    zip: "33101",
                    radiusMi: 50,
                    fuel: null,
                    drivetrain: null,
                    sort: null,
                    limit: 10,
                    searchWhy: "Named model",
                    summary: null,
                    confidence: null,
                    picks: null,
                    relaxedConditions: null,
                    passReason: null,
                  }),
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
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
                  summary: "Take the RAV4.",
                  confidence: "medium",
                  picks: [
                    {
                      vin: VIN,
                      label: "2021 Toyota RAV4",
                      action: "negotiate",
                      offerUsd: 23_500,
                      why: "Asking near comps.",
                    },
                  ],
                  relaxedConditions: [],
                  passReason: null,
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const result = await runFindAgentLoop({
      note: "RAV4 near Miami",
      mode: "next_action",
      deps: {
        servKey: "test-serv",
        autodevKey: "test-autodev",
        fetch: fetchImpl,
        budgetUsd: 26_000,
        autodev: { cache: new TtlCache<unknown>(), counter: new MemoryCounter() },
      },
      maxRounds: 10,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agentMode).toBe("next_action");
    expect(result.toolRounds).toBe(1);
    expect(result.verdict.picks[0]?.action).toBe("negotiate");
  });
});
