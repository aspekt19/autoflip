/**
 * Real Find/Resale chat paths must bound work per HTTP invocation under Hobby 300s.
 * Long searches resume across requests via checkpoint + status=continue — never by
 * stretching a single invocation past the route budget.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FIND_DECIDE_ROUTE_MS } from "@/domain/route-budget";
import {
  RESALE_HANDLER_HARD_CAP_MS,
  RESALE_INTERNAL_BUDGET_MS,
} from "@/domain/resale-deadline";
import {
  AGENT_LOOP_MIN_REMAINING_TO_START_MS,
  AGENT_LOOP_REQUEST_BUDGET_MS,
} from "@/domain/agent-loop-deadline";

const HOBBY_MS = 300_000;
const ROOT = path.resolve(__dirname, "../../..");

function readSrc(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

describe("Find/Resale chat: bounded work per invocation", () => {
  it("keeps per-request budgets strictly under Hobby 300s", () => {
    expect(FIND_DECIDE_ROUTE_MS).toBeLessThanOrEqual(HOBBY_MS);
    expect(RESALE_INTERNAL_BUDGET_MS).toBeLessThanOrEqual(HOBBY_MS);
    expect(RESALE_HANDLER_HARD_CAP_MS).toBeLessThanOrEqual(HOBBY_MS);
    expect(AGENT_LOOP_REQUEST_BUDGET_MS).toBeLessThanOrEqual(HOBBY_MS);
    expect(AGENT_LOOP_MIN_REMAINING_TO_START_MS).toBeGreaterThan(0);
  });

  it("Find and Resale chat routes export maxDuration 300 and call one turn helper", () => {
    const findRoute = readSrc("src/app/api/find/chat/route.ts");
    const resaleRoute = readSrc("src/app/api/resale/chat/route.ts");

    expect(findRoute).toMatch(/export\s+const\s+maxDuration\s*=\s*300\s*;/);
    expect(resaleRoute).toMatch(/export\s+const\s+maxDuration\s*=\s*300\s*;/);
    expect(findRoute).toContain("runFindChatTurn(");
    expect(resaleRoute).toContain("runResaleChatTurn(");
    // One turn per request — no in-route hop loop.
    expect(findRoute).not.toContain("driveServChatEval");
    expect(resaleRoute).not.toContain("driveServChatEval");
    expect(findRoute).not.toMatch(/for\s*\(/);
    expect(resaleRoute).not.toMatch(/for\s*\(/);
    expect(findRoute).not.toMatch(/while\s*\(/);
    expect(resaleRoute).not.toMatch(/while\s*\(/);
  });

  it("chat servers pass a Hobby-safe deadline budget into the agent loop", () => {
    const findChat = readSrc("src/server/find-chat.ts");
    const resaleChat = readSrc("src/server/resale-chat.ts");

    expect(findChat).toContain("FIND_DECIDE_ROUTE_MS");
    expect(findChat).toContain("budgetMs: FIND_DECIDE_ROUTE_MS");
    expect(findChat).toContain("makeAgentLoopDeadline(FIND_DECIDE_ROUTE_MS)");
    expect(findChat).toContain('status: "continue"');

    expect(resaleChat).toContain("RESALE_INTERNAL_BUDGET_MS");
    expect(resaleChat).toContain("budgetMs: RESALE_INTERNAL_BUDGET_MS");
    expect(resaleChat).toContain("makeAgentLoopDeadline(RESALE_INTERNAL_BUDGET_MS)");
    expect(resaleChat).toContain('status: "continue"');
  });

  it("eval-live steps one hop per request (no driveServChatEval loop in the route)", () => {
    const route = readSrc("src/app/api/internal/eval-live/route.ts");
    expect(route).toMatch(/export\s+const\s+maxDuration\s*=\s*300\s*;/);
    expect(route).toContain("runEvalChatHop");
    expect(route).not.toContain("driveServChatEval");
    expect(route).not.toContain("runOneQuery");
    expect(route).not.toContain("runOneResaleQuery");
  });
});
