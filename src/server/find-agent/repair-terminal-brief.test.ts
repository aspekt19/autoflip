/**
 * Structural gates for live-eval root-cause classes:
 * A) boundary failures → repair message (never silent 502 substitution)
 * B) typed terminal required (submit_picks | submit_nothing_fits)
 * C) no search without confirmed brief
 */
import { describe, expect, it } from "vitest";
import {
  boundaryRepairMessage,
  scoringVerdictComplete,
} from "@/domain/agent-verdict-complete";
import { findAgentChatTools, createFindAgentToolState, executeFindAgentTool } from "./tools";
import { TtlCache } from "@/io/cache";
import { MemoryCounter } from "@/io/quota";
import { readFileSync } from "node:fs";
import path from "node:path";

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
