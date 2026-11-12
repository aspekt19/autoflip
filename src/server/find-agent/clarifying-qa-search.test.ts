/**
 * SERV clarifying question → shopper answer → first SERV search request
 * includes the Q&A in context before search_listings.
 */
import { describe, expect, it } from "vitest";
import { MemoryCounter } from "@/io/quota";
import { TtlCache } from "@/io/cache";
import { runFindAgentLoop } from "./loop";

const VIN = "4T1KZ1AK4MU060006";

function isServResponsesUrl(url: string): boolean {
  return url.includes("/v1/responses") || url.includes("/responses");
}

function listing() {
  return {
    id: "1",
    vin: VIN,
    year: 2021,
    make: "Toyota",
    model: "RAV4",
    price: 24_000,
    miles: 32_000,
    dealer: { zip: "33101" },
  };
}

function autodevListingsPayload(rows: unknown[]) {
  return { listings: rows, num_found: rows.length };
}

describe("clarifying Q&A reaches first SERV search request", () => {
  it("includes SERV question + answer in the first Responses instructions before search_listings", async () => {
    let firstInstructions: string | null = null;
    let responsesCalls = 0;
    let searchListingsSeen = false;

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/listings")) {
        searchListingsSeen = true;
        return new Response(JSON.stringify(autodevListingsPayload([listing()])), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (isServResponsesUrl(url)) {
        responsesCalls += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          instructions?: string;
        };
        if (responsesCalls === 1) {
          firstInstructions = typeof body.instructions === "string" ? body.instructions : "";
          expect(firstInstructions).toMatch(/What ZIP should we shop around\?/i);
          expect(firstInstructions).toMatch(/33101/);
          expect(firstInstructions).toMatch(/clarifying Q&A/i);
          expect(searchListingsSeen).toBe(false);
          return new Response(
            JSON.stringify({
              id: "resp_qa_1",
              output: [
                {
                  type: "function_call",
                  id: "fc_1",
                  call_id: "call_search_1",
                  name: "search_listings",
                  arguments: JSON.stringify({
                    make: "Toyota",
                    model: "RAV4",
                    bodyStyle: null,
                    bodyFamily: "suv",
                    priceMaxUsd: 26000,
                    milesMax: null,
                    yearMin: null,
                    yearMax: null,
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
        return new Response(
          JSON.stringify({
            id: "resp_qa_2",
            output: [
              {
                type: "function_call",
                id: "fc_submit",
                call_id: "call_submit_1",
                name: "submit_picks",
                arguments: JSON.stringify({
                  summary: "Buy the RAV4 near 33101.",
                  confidence: "high",
                  picks: [
                    {
                      vin: VIN,
                      label: "2021 Toyota RAV4",
                      action: "buy",
                      offerUsd: 24_000,
                      why: "Fits budget near the answered ZIP.",
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
      note: "Toyota RAV4 under $26k near me",
      mode: "tools",
      clarifyingQa: [
        {
          question: "What ZIP should we shop around?",
          answer: "33101",
        },
      ],
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
    expect(firstInstructions).toMatch(/Q: What ZIP should we shop around\? A: 33101/);
    expect(result.journal.some((e) => e.kind === "clarifying_qa")).toBe(true);
    const qaIdx = result.journal.findIndex((e) => e.kind === "clarifying_qa");
    const searchIdx = result.journal.findIndex(
      (e) => e.kind === "tool" && e.name === "search_listings",
    );
    expect(qaIdx).toBeGreaterThanOrEqual(0);
    expect(searchIdx).toBeGreaterThan(qaIdx);
  });
});
