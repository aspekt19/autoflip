/**
 * Golden-style structural coverage for Resale profit-first (Yura directive):
 * budget-first intake → budget-only brief → broad search, no invented body.
 */
import { describe, expect, it } from "vitest";
import {
  formatShopperBriefCard,
  parseShopperBrief,
  RESALE_INVENTED_BODY_KEYS,
  validateResaleProfitFirstBrief,
} from "./shopper-brief";
import { resaleAgentStableInstructions } from "@/server/resale-agent/loop";
import {
  RESALE_SUBMIT_BRIEF_PARAMETERS,
  resaleAgentChatTools,
  executeResaleAgentTool,
  createResaleAgentToolState,
} from "@/server/resale-agent/tools";
import { TtlCache } from "@/io/cache";
import { MemoryCounter } from "@/io/quota";

describe("Resale profit-first golden: budget-only brief", () => {
  it("instructions: budget first, one optional ask, no invented body on budget-only", () => {
    const instructions = resaleAgentStableInstructions();
    expect(instructions).toMatch(/ask for budget first/i);
    expect(instructions).toMatch(/ask once whether the shopper wants to add/i);
    expect(instructions).toMatch(/budgetOnly=true/i);
    expect(instructions).toMatch(/invent no body\/type/i);
    expect(instructions).toMatch(/search broadly for the best flip by expected code profit/i);
    expect(instructions).toMatch(/rank by code mid-profit/i);
    // Must not prefer inventing a car body on budget-only searches.
    expect(instructions).not.toMatch(/Prefer bodyFamily=car/i);
  });

  it("submit_brief schema requires budget+quote, budgetOnly, riskNotes", () => {
    const required = RESALE_SUBMIT_BRIEF_PARAMETERS.required as string[];
    expect(required).toEqual(
      expect.arrayContaining(["summary", "budget", "zip", "radiusMi", "budgetOnly", "riskNotes"]),
    );
    const tools = resaleAgentChatTools();
    const brief = tools.find((t) => t.function.name === "submit_brief");
    expect(brief?.function.description).toMatch(/profit-first/i);
    expect(brief?.function.parameters).toBe(RESALE_SUBMIT_BRIEF_PARAMETERS);
  });

  it("budget-only brief: budget + location, no invented body hardConstraint", () => {
    const parsed = parseShopperBrief({
      summary: "Flip under $12k near Austin — broad profit search",
      budget: { maxUsd: 12_000, userQuote: "under $12k" },
      zip: "78701",
      radiusMi: 75,
      notes: null,
      budgetOnly: true,
      hardConstraints: [],
      riskNotes: [],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.brief.budgetOnly).toBe(true);
    expect(parsed.brief.hardConstraints ?? []).toEqual([]);
    const gate = validateResaleProfitFirstBrief(parsed.brief);
    expect(gate).toEqual({ ok: true });
    const card = formatShopperBriefCard(parsed.brief);
    expect(card).toMatch(/Budget: \$12,000/);
    expect(card).toMatch(/78701/);
    expect(card).toMatch(/75 mi/);
    expect(card).toMatch(/budget \+ location only/i);
    expect(card).not.toMatch(/Hard:.*body/i);
  });

  it("rejects invented body hardConstraint on budget-only Resale brief", () => {
    const parsed = parseShopperBrief({
      summary: "SUV flips under 15k",
      budget: { maxUsd: 15_000, userQuote: "15k" },
      zip: "75201",
      radiusMi: 100,
      notes: null,
      budgetOnly: true,
      hardConstraints: [{ key: "bodyStyle", value: "SUV" }],
      riskNotes: [],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const gate = validateResaleProfitFirstBrief(parsed.brief);
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.issues.some((i) => /invent body\/type/i.test(i.message))).toBe(true);
    expect(RESALE_INVENTED_BODY_KEYS.has("bodyStyle")).toBe(true);
  });

  it("user-added constraints are hard and need risk notes on the brief", () => {
    const missingRisk = parseShopperBrief({
      summary: "Toyota flips under 18k",
      budget: { maxUsd: 18_000, userQuote: "18k" },
      zip: "85001",
      radiusMi: 90,
      notes: null,
      budgetOnly: false,
      hardConstraints: [{ key: "make", value: "Toyota" }],
      riskNotes: [],
    });
    expect(missingRisk.ok).toBe(true);
    if (!missingRisk.ok) return;
    expect(validateResaleProfitFirstBrief(missingRisk.brief).ok).toBe(false);

    const withRisk = parseShopperBrief({
      summary: "Toyota flips under 18k",
      budget: { maxUsd: 18_000, userQuote: "18k" },
      zip: "85001",
      radiusMi: 90,
      notes: null,
      budgetOnly: false,
      hardConstraints: [{ key: "make", value: "Toyota" }],
      riskNotes: [
        {
          key: "make",
          risk: "Narrowing to Toyota may miss higher-profit flips in other makes.",
        },
      ],
    });
    expect(withRisk.ok).toBe(true);
    if (!withRisk.ok) return;
    expect(validateResaleProfitFirstBrief(withRisk.brief)).toEqual({ ok: true });
    expect(formatShopperBriefCard(withRisk.brief)).toMatch(/Risks: make —/);
  });

  it("executeResaleAgentTool submit_brief enforces profit-first (no chat parse)", async () => {
    const state = createResaleAgentToolState();
    state.requireBriefConfirm = true;
    const deps = {
      fetch: (async () => new Response("{}", { status: 500 })) as typeof fetch,
      autodevKey: "test",
      autodev: { cache: new TtlCache(), counter: new MemoryCounter() },
      chatTranscript: "Shopper: under $12k near Austin. Nothing else.",
    };
    const rejected = await executeResaleAgentTool(
      "submit_brief",
      {
        summary: "Invented coupe search",
        budget: { maxUsd: 12_000, userQuote: "under $12k" },
        zip: "78701",
        radiusMi: 75,
        notes: null,
        budgetOnly: true,
        hardConstraints: [{ key: "body", value: "coupe" }],
        riskNotes: [],
      },
      deps,
      state,
    );
    expect(rejected.ok).toBe(false);
    expect(rejected.result.error).toBe("resale_profit_first");

    const accepted = await executeResaleAgentTool(
      "submit_brief",
      {
        summary: "Broad flip under 12k near Austin",
        budget: { maxUsd: 12_000, userQuote: "under $12k" },
        zip: "78701",
        radiusMi: 75,
        notes: null,
        budgetOnly: true,
        hardConstraints: [],
        riskNotes: [],
      },
      deps,
      state,
    );
    expect(accepted.ok).toBe(true);
    const brief = (accepted.result as { brief?: { budgetOnly?: boolean } }).brief;
    expect(brief?.budgetOnly).toBe(true);
    expect(String((accepted.result as { card?: string }).card ?? "")).toMatch(
      /budget \+ location only/i,
    );
  });
});
