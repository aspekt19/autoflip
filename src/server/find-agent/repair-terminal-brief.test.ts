/**
 * Structural gates for live-eval root-cause classes:
 * A) boundary failures → repair message (never silent 502 substitution)
 * B) typed terminal required (submit_picks | submit_nothing_fits)
 * C) no search without confirmed brief
 * D) confirmed-brief budget: listing asking ≤ maxUsd at terminal
 * E) empty-search terminal → honest nothing-fits (not incomplete_verdict)
 */
import { describe, expect, it } from "vitest";
import {
  boundaryRepairMessage,
  honestNothingFitsReasonFromSearches,
  searchesAllEmpty,
  scoringVerdictComplete,
} from "@/domain/agent-verdict-complete";
import { validateFindSubmitPicks } from "@/domain/find-agent";
import { validateResaleSubmitPicks } from "@/domain/resale-agent";
import { listingPriceBudgetIssue } from "@/domain/serv-boundary";
import { findAgentChatTools, createFindAgentToolState, executeFindAgentTool, listingToCard } from "./tools";
import { TtlCache } from "@/io/cache";
import { MemoryCounter } from "@/io/quota";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Listing } from "@/domain/types";

describe("A) boundary checks repair with journal evidence", () => {
  it("repair message names the exact problem and attaches code journal evidence", () => {
    const msg = boundaryRepairMessage({
      issues: [
        {
          message:
            "Nothing-fits requires prior search_listings calls in the code journal (params + result count + HTTP status when present).",
        },
      ],
      searches: [
        {
          params: { zip: "97201", priceMaxUsd: 8000 },
          resultCount: 0,
          providerStatus: 200,
        },
      ],
    });
    expect(msg).toMatch(/Boundary check failed/);
    expect(msg).toMatch(/submit_picks or submit_nothing_fits/);
    expect(msg).toMatch(/zip=97201/);
    expect(msg).toMatch(/http=200/);
    expect(msg).toMatch(/do not re-document/i);
  });

  it("accepts nothing-fits when code journal already documented searches", () => {
    const result = scoringVerdictComplete({
      verdict: {
        picks: [],
        nothingFitsReason: "Budget + cargo needs left nothing after the searches code journaled.",
      },
      searches: [{ params: { zip: "80202" }, resultCount: 0, providerStatus: 200 }],
    });
    expect(result).toEqual({ complete: true, kind: "nothing_fits" });
  });
});

describe("B) typed terminal tools", () => {
  it("exposes submit_picks and submit_nothing_fits as terminal tools", () => {
    const names = findAgentChatTools().map((t) => t.function.name);
    expect(names).toContain("submit_picks");
    expect(names).toContain("submit_nothing_fits");
  });

  it("Find/Resale tools loops require a terminal tool — no chat-schema silent finish", () => {
    const findLoop = readFileSync(path.join(__dirname, "loop.ts"), "utf8");
    const resaleLoop = readFileSync(path.join(__dirname, "../resale-agent/loop.ts"), "utf8");
    expect(findLoop).toMatch(/missing_terminal/);
    expect(findLoop).toMatch(/submit_nothing_fits/);
    expect(findLoop).toMatch(/FIND_TERMINAL_NUDGE|No terminal tool yet/);
    expect(resaleLoop).toMatch(/missing_terminal/);
    expect(resaleLoop).toMatch(/submit_nothing_fits/);
    // Tools mode must not fall through to finalizeVerdict after the terminal nudge.
    const toolsBlock = findLoop.slice(
      findLoop.indexOf("async function runToolsMode"),
      findLoop.indexOf("async function runNextActionMode"),
    );
    expect(toolsBlock).toMatch(/missing_terminal/);
    expect(toolsBlock).not.toMatch(/finalizeVerdict\(/);
    // Text-without-terminal repair forces tool_choice=required on /v1/responses.
    expect(toolsBlock).toMatch(/toolChoice: selectionHop \|\| forceTerminalTool \? "required"/);
    expect(resaleLoop).toMatch(/toolChoice: selectionHop \|\| forceTerminalTool \? "required"/);
    // Validation failure drops selectionHop so Kronos/Shadow stay off repair retries.
    expect(toolsBlock).toMatch(/selectionHop = false/);
    expect(resaleLoop).toMatch(/selectionHop = false/);
  });

  it("Radar uses verdict_decide — not Find/Resale terminal tools (documented audit)", () => {
    const radar = readFileSync(path.join(__dirname, "../radar-serv.ts"), "utf8");
    expect(radar).not.toMatch(/submit_picks/);
    expect(radar).not.toMatch(/submit_nothing_fits/);
    expect(radar).toMatch(/verdict_decide|radar_review/);
  });
});

describe("C) brief gate — no search without confirm", () => {
  const deps = {
    fetch: (async () => new Response("should not run", { status: 500 })) as typeof fetch,
    autodevKey: "test",
    autodev: { cache: new TtlCache<unknown>(), counter: new MemoryCounter() },
  };

  it("blocks search_listings and terminal tools until brief is confirmed", async () => {
    const state = createFindAgentToolState();
    state.requireBriefConfirm = true;
    state.briefConfirmed = false;
    for (const name of ["search_listings", "submit_picks", "submit_nothing_fits"] as const) {
      const blocked = await executeFindAgentTool(name, { reason: "x", make: "Toyota" }, deps, state);
      expect(blocked.ok).toBe(false);
      expect(blocked.result.error).toBe("brief_not_confirmed");
    }
  });

  it("rejects repeated submit_brief after confirmation", async () => {
    const state = createFindAgentToolState();
    state.requireBriefConfirm = true;
    state.briefConfirmed = true;
    const blocked = await executeFindAgentTool(
      "submit_brief",
      {
        summary: "already confirmed",
        budget: { maxUsd: null, userQuote: null },
        zip: "98101",
        radiusMi: 50,
        notes: null,
      },
      deps,
      state,
    );
    expect(blocked.ok).toBe(false);
    expect(blocked.result.error).toBe("brief_already_confirmed");
  });

  it("chat routes always set requireBriefConfirm (source invariant)", () => {
    const findChat = readFileSync(path.join(__dirname, "../find-chat.ts"), "utf8");
    const resaleChat = readFileSync(path.join(__dirname, "../resale-chat.ts"), "utf8");
    expect(findChat).toMatch(/requireBriefConfirm:\s*true/);
    expect(resaleChat).toMatch(/requireBriefConfirm:\s*true/);
    // Soft finish — never 502 on agent boundary failure.
    expect(findChat).toMatch(/never 502|couldn't finish/i);
    expect(resaleChat).toMatch(/never 502|couldn't finish/i);
    expect(findChat).not.toMatch(/status:\s*502/);
    expect(resaleChat).not.toMatch(/status:\s*502/);
  });
});

describe("D) confirmed-brief budget — listing asking ≤ maxUsd", () => {
  const vin = "4T1DAACK0TU295949";
  const listings = new Map([[vin, { vin, priceUsd: 25_835, miles: 5_173 }]]);

  it("shared helper flags asking above maxUsd", () => {
    const issue = listingPriceBudgetIssue({
      listingPriceUsd: 25_835,
      budgetUsd: 25_000,
      vin,
    });
    expect(issue).not.toBeNull();
    expect(issue?.message).toMatch(/25,?835/);
    expect(issue?.message).toMatch(/25,?000/);
  });

  it("Find + Resale submit_picks reject over-budget listing asking (repair)", () => {
    const find = validateFindSubmitPicks(
      {
        summary: "Camry pick.",
        confidence: "high",
        picks: [{ vin, label: "Camry", action: "buy", offerUsd: 25_000, why: "Under offer cap." }],
        relaxedConditions: [],
        passReason: null,
      },
      { listingsByVin: listings, budgetUsd: 25_000 },
    );
    expect(find.ok).toBe(false);

    const resale = validateResaleSubmitPicks(
      {
        summary: "Camry flip.",
        confidence: "high",
        picks: [{ vin, action: "buy", offerUsd: 25_000, why: "Quick flip." }],
        relaxedConditions: [],
      },
      { listingsByVin: listings, budgetUsd: 25_000 },
    );
    expect(resale.ok).toBe(false);
  });

  it("Radar hardReject already gates priceMax (source invariant)", () => {
    const radarWatch = readFileSync(path.join(__dirname, "../../domain/radar-watch.ts"), "utf8");
    expect(radarWatch).toMatch(/listing\.priceUsd > criteria\.priceMax/);
    expect(radarWatch).toMatch(/over budget/);
  });
});

describe("E) empty-search terminal → honest nothing-fits", () => {
  it("all-empty journal becomes a complete nothing-fits reason", () => {
    const searches = [
      { params: { zip: "33101", priceMaxUsd: 18_000 }, resultCount: 0, providerStatus: 200 },
    ];
    expect(searchesAllEmpty(searches)).toBe(true);
    const reason = honestNothingFitsReasonFromSearches(searches);
    expect(scoringVerdictComplete({ verdict: { picks: [], nothingFitsReason: reason }, searches })).toEqual({
      complete: true,
      kind: "nothing_fits",
    });
  });

  it("Find/Resale loops promote empty journal to honest nothing-fits after nudge (source)", () => {
    const findLoop = readFileSync(path.join(__dirname, "loop.ts"), "utf8");
    const resaleLoop = readFileSync(path.join(__dirname, "../resale-agent/loop.ts"), "utf8");
    expect(findLoop).toMatch(/honestEmptyNothingFitsFromJournal/);
    expect(findLoop).toMatch(/submit_nothing_fits with rejectedCandidates: \[\] and a short written reason/);
    expect(resaleLoop).toMatch(/honestEmptyNothingFitsFromResaleJournal/);
    expect(resaleLoop).toMatch(/submit_nothing_fits with a short written reason now/);
  });

  it("listing cards carry the feed detail-page URL when present", () => {
    const card = listingToCard({
      vin: "JTMRWRFV0KJ123456",
      year: 2018,
      make: "Toyota",
      model: "Camry",
      trim: "LE",
      miles: 62_000,
      priceUsd: 14_500,
      city: "Columbus",
      state: "OH",
      zip: "43215",
      dealer: "Test",
      vdp: "https://dealer.example/inventory/used-2018-toyota-camry/JTMRWRFV0KJ123456",
      dealerUrl: "https://dealer.example/",
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
      transmission: "Automatic",
      bodyStyle: "Car",
      style: "Sedan",
      distanceMiles: 10,
      createdAt: null,
      latitude: null,
      longitude: null,
      removedAt: null,
      source: "autodev",
    } satisfies Listing);
    expect(card?.listingUrl).toContain("/inventory/used-2018-toyota-camry/");
  });
});
