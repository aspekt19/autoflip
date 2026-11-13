import { describe, expect, it } from "vitest";
import { applyFindAgentGuardrails, validateFindAgentVerdict, validateFindSubmitPicks } from "@/domain/find-agent";
import { TtlCache } from "@/io/cache";
import { MemoryCounter } from "@/io/quota";
import type { Listing } from "@/domain/types";
import { isServChatCompletionsUrl, isServResponsesUrl } from "@/server/serv/agent-chat-turn";
import { BASE_MODEL } from "@/server/serv";
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

  it("submit_picks rejects invented VIN and over-asking offer", () => {
    const listings = new Map([[VIN, { vin: VIN, priceUsd: 24_500 }]]);
    const badVin = validateFindSubmitPicks(
      {
        summary: "Nope.",
        confidence: "low",
        picks: [{ vin: "INVENTEDVIN000001", label: "Fake", action: "buy", offerUsd: 10_000, why: "x" }],
        relaxedConditions: [],
        passReason: null,
      },
      { listingsByVin: listings, budgetUsd: 26_000 },
    );
    expect(badVin.ok).toBe(false);

    const overAsk = validateFindSubmitPicks(
      {
        summary: "Over ask.",
        confidence: "medium",
        picks: [{ vin: VIN, label: "RAV4", action: "buy", offerUsd: 26_000, why: "x" }],
        relaxedConditions: [],
        passReason: null,
      },
      { listingsByVin: listings, budgetUsd: 30_000 },
    );
    expect(overAsk.ok).toBe(false);
  });

  it("submit_picks rejects listing asking above confirmed brief maxUsd (even if offer ≤ budget)", () => {
    const listings = new Map([[VIN, { vin: VIN, priceUsd: 25_835 }]]);
    const overListing = validateFindSubmitPicks(
      {
        summary: "Over listing budget.",
        confidence: "high",
        picks: [{ vin: VIN, label: "Camry", action: "buy", offerUsd: 25_000, why: "Offer under 25k." }],
        relaxedConditions: [],
        passReason: null,
      },
      { listingsByVin: listings, budgetUsd: 25_000 },
    );
    expect(overListing.ok).toBe(false);
    if (!overListing.ok) {
      expect(overListing.issues.some((i) => i.field.includes("price") && /25,?835/.test(i.message))).toBe(
        true,
      );
    }
  });
});

describe("runFindAgentLoop", () => {
  it("tools mode: Responses parallel calls + reasoning kept + submit_picks", async () => {
    let responsesCalls = 0;
    let sawReasoningEcho = false;
    let sawBothOutputs = false;
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
        return new Response(JSON.stringify(autodevListingsPayload([listing()])), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (isServResponsesUrl(url)) {
        responsesCalls += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          model?: string;
          tools?: Array<{ type?: string; name?: string }>;
          reasoning?: { effort?: string };
          instructions?: string;
          input?: unknown;
          max_output_tokens?: number;
        };
        expect(typeof body.instructions).toBe("string");
        expect(body.instructions!.length).toBeGreaterThan(0);
        expect(body.instructions).not.toMatch(/Shopper conversation \/ note:/i);
        expect(Array.isArray(body.tools) && body.tools.some((t) => t.name === "submit_picks")).toBe(true);
        expect(body.reasoning?.effort).toBe("low");
        expect(Array.isArray(body.input)).toBe(true);
        expect(typeof body.max_output_tokens).toBe("number");

        if (responsesCalls === 1) {
          // Search hop (no journaled searches yet): bare model + first-turn prompt_guard.
          expect(body.model).toBe(BASE_MODEL);
          expect(body.tools?.map((t) => t.name)[0]).toBe("serv_prompt_guard");
          expect(body.tools?.some((t) => t.name === "serv_shadow_agent")).toBe(false);
          return new Response(
            JSON.stringify({
              id: "resp_tools_1",
              output: [
                { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Try Toyota + Honda." }] },
                {
                  type: "function_call",
                  id: "fc_1",
                  call_id: "call_search_toyota",
                  name: "search_listings",
                  arguments: JSON.stringify({
                    make: "Toyota",
                    model: "RAV4",
                    bodyStyle: null,
                    bodyFamily: "suv",
                    priceMaxUsd: 26000,
                    milesMax: 60000,
                    yearMin: 2019,
                    yearMax: 2022,
                    zip: "33101",
                    radiusMi: 100,
                    transmission: null,
                    fuel: null,
                    drivetrain: null,
                    sort: null,
                    limit: 10,
                  }),
                },
                {
                  type: "function_call",
                  id: "fc_2",
                  call_id: "call_search_honda",
                  name: "search_listings",
                  arguments: JSON.stringify({
                    make: "Honda",
                    model: "CR-V",
                    bodyStyle: null,
                    bodyFamily: "suv",
                    priceMaxUsd: 26000,
                    milesMax: 60000,
                    yearMin: 2019,
                    yearMax: 2022,
                    zip: "33101",
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
        const outs = inputItems.filter((item) => item.type === "function_call_output");
        const callIds = outs.map((o) => o.call_id).sort();
        if (callIds.includes("call_search_honda") && callIds.includes("call_search_toyota")) {
          sawBothOutputs = true;
        }

        if (responsesCalls === 2) {
          // After searches: still search step (bare) — terminal tools defer to selection hop.
          expect(body.model).toBe(BASE_MODEL);
          expect(body.tools?.some((t) => t.name === "serv_shadow_agent")).toBe(false);
          expect(body.tools?.some((t) => t.name === "serv_prompt_guard")).toBe(false);
          return new Response(
            JSON.stringify({
              id: "resp_tools_2",
              output: [
                {
                  type: "function_call",
                  id: "fc_submit_early",
                  call_id: "call_submit_early",
                  name: "submit_picks",
                  arguments: JSON.stringify({
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
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        if (responsesCalls === 3) {
          // Dedicated selection hop — kronos-multipath + shadow, no prompt_guard.
          expect(body.model).toBe(`${BASE_MODEL}-serv-kronos-multipath`);
          expect(body.tools?.map((t) => t.name)[0]).toBe("serv_shadow_agent");
          expect(body.tools?.some((t) => t.name === "serv_prompt_guard")).toBe(false);
          return new Response(
            JSON.stringify({
              id: "resp_tools_3",
              usage: {
                input_tokens: 100,
                output_tokens: 40,
                total_tokens: 140,
                input_tokens_details: { cached_tokens: 80 },
              },
              output: [
                {
                  type: "function_call",
                  id: "fc_submit",
                  call_id: "call_submit_1",
                  name: "submit_picks",
                  arguments: JSON.stringify({
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
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        return new Response(
          JSON.stringify({
            id: "resp_tools_4",
            output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (isServChatCompletionsUrl(url)) {
        return new Response("{}", { status: 500 });
      }
      return new Response("{}", { status: 404 });
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
    expect(result.toolRounds).toBeGreaterThanOrEqual(3);
    expect(result.verdict.picks[0]?.vin).toBe(VIN);
    expect(result.relaxedConditions[0]?.name).toBe("radius");
    expect(sawReasoningEcho).toBe(true);
    expect(sawBothOutputs).toBe(true);
    expect(responsesCalls).toBe(3);
    expect(result.servFeatures.features).toEqual(
      expect.arrayContaining(["serv_shadow_agent", "multipath", "kronos"]),
    );
    expect(result.servFeatures.features).not.toContain("serv_prompt_guard");
    expect(result.featureFlags).toEqual([]);
    const servRows = result.journal.filter((e) => e.kind === "serv");
    expect(servRows.some((e) => e.usage?.cached_tokens === 80)).toBe(true);
  });

  it("tools mode: rejected submit_picks returns issues then accepts repair", async () => {
    let responsesCalls = 0;
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
        return new Response(JSON.stringify(autodevListingsPayload([listing()])), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (isServResponsesUrl(url)) {
        responsesCalls += 1;
        if (responsesCalls === 1) {
          return new Response(
            JSON.stringify({
              id: "resp_1",
              output: [
                {
                  type: "function_call",
                  call_id: "call_search_1",
                  name: "search_listings",
                  arguments: JSON.stringify({
                    make: "Toyota",
                    model: "RAV4",
                    bodyStyle: null,
                    bodyFamily: null,
                    priceMaxUsd: 26000,
                    milesMax: null,
                    yearMin: null,
                    yearMax: null,
                    zip: "33101",
                    radiusMi: 50,
                    transmission: null,
                    fuel: null,
                    drivetrain: null,
                    sort: null,
                    limit: 5,
                  }),
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (responsesCalls === 2) {
          // Search hop: first terminal attempt is deferred to selection hop.
          return new Response(
            JSON.stringify({
              id: "resp_2",
              output: [
                {
                  type: "function_call",
                  call_id: "call_submit_early",
                  name: "submit_picks",
                  arguments: JSON.stringify({
                    summary: "Invented.",
                    confidence: "high",
                    picks: [
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
                  }),
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (responsesCalls === 3) {
          // Selection hop: invalid VIN rejected for repair (features drop after this).
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            model?: string;
            tools?: Array<{ name?: string }>;
          };
          expect(body.model).toBe(`${BASE_MODEL}-serv-kronos-multipath`);
          expect(body.tools?.some((t) => t.name === "serv_shadow_agent")).toBe(true);
          return new Response(
            JSON.stringify({
              id: "resp_3",
              output: [
                {
                  type: "function_call",
                  call_id: "call_submit_bad",
                  name: "submit_picks",
                  arguments: JSON.stringify({
                    summary: "Invented.",
                    confidence: "high",
                    picks: [
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
                  }),
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (responsesCalls === 4) {
          // Bare repair hop (no Kronos/Shadow) with tool_choice required — terminal deferred again.
          const body = JSON.parse(String(init?.body ?? "{}")) as {
            model?: string;
            tool_choice?: string;
            tools?: Array<{ name?: string }>;
            input?: Array<Record<string, unknown>>;
          };
          expect(body.model).toBe(BASE_MODEL);
          expect(body.tool_choice).toBe("required");
          expect(body.tools?.some((t) => t.name === "serv_shadow_agent")).toBe(false);
          const lastOut = [...(body.input ?? [])].reverse().find((item) => item.type === "function_call_output");
          expect(String(lastOut?.output ?? "")).toContain("validation_failed");
          return new Response(
            JSON.stringify({
              id: "resp_4",
              output: [
                {
                  type: "function_call",
                  call_id: "call_submit_ok_early",
                  name: "submit_picks",
                  arguments: JSON.stringify({
                    summary: "Fixed.",
                    confidence: "medium",
                    picks: [
                      {
                        vin: VIN,
                        label: "2021 Toyota RAV4",
                        action: "negotiate",
                        offerUsd: 23_000,
                        why: "Real VIN.",
                      },
                    ],
                    relaxedConditions: [],
                    passReason: null,
                  }),
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        // Final selection hop with features — accepted terminal.
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          model?: string;
          tools?: Array<{ name?: string }>;
        };
        expect(body.model).toBe(`${BASE_MODEL}-serv-kronos-multipath`);
        expect(body.tools?.some((t) => t.name === "serv_shadow_agent")).toBe(true);
        return new Response(
          JSON.stringify({
            id: "resp_5",
            output: [
              {
                type: "function_call",
                call_id: "call_submit_ok",
                name: "submit_picks",
                arguments: JSON.stringify({
                  summary: "Fixed.",
                  confidence: "medium",
                  picks: [
                    {
                      vin: VIN,
                      label: "2021 Toyota RAV4",
                      action: "negotiate",
                      offerUsd: 23_000,
                      why: "Real VIN.",
                    },
                  ],
                  relaxedConditions: [],
                  passReason: null,
                }),
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    };

    const result = await runFindAgentLoop({
      note: "RAV4",
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
    expect(result.verdict.picks[0]?.vin).toBe(VIN);
    expect(responsesCalls).toBe(5);
  });

  it("next_action mode: search then finish", async () => {
    let servCalls = 0;
    const fetchImpl: typeof fetch = async (input) => {
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
        return new Response(JSON.stringify(autodevListingsPayload([listing()])), {
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
