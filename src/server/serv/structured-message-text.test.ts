/**
 * Offline regressions for scout_plan structured-output extraction (t301).
 *
 * Synthetic draft-as-JSON hazard (offline fixtures — not proven live Luna RCA; raw Luna
 * bodies were not retained): messageText fell through to tool_call args / reasoning-draft
 * JSON when content was empty. That non-empty wrong text made runServ report ok:true, so
 * production empty-text recovery never ran, and parseScoutPlanText failed with
 * "Missing reason or servStepId".
 *
 * After fix: jsonSchema profiles use structured extraction (content/parsed/refusal only).
 * No paid calls. servStepId is execution-owned (not in request schema).
 */
import { describe, expect, it } from "vitest";
import { parseScoutPlanText } from "@/server/scout/plan-parse";
import { experimentServDeps, messageText, profile, runServ } from "./index";

const TOOL_ARGS_ONLY = {
  choices: [
    {
      finish_reason: "tool_calls",
      message: {
        content: null,
        tool_calls: [
          {
            function: {
              name: "inventory.search",
              arguments: JSON.stringify({
                makes: ["Toyota"],
                models: null,
                zip: "72712",
                distanceMiles: null,
              }),
            },
          },
        ],
      },
    },
  ],
};

const REASONING_DRAFT_ONLY = {
  choices: [
    {
      finish_reason: "stop",
      message: {
        content: null,
        reasoning:
          'drafting plan {"type":"abstain","vin":null,"toolId":null,"args":null} still missing fields',
      },
    },
  ],
};

const VALID_ABSTAIN_CONTENT = {
  choices: [
    {
      finish_reason: "stop",
      message: {
        content: JSON.stringify({
          type: "abstain",
          reason: "all pending asks unusable",
          servStepId: "a1",
          vin: null,
          toolId: null,
          args: null,
          rationaleKind: null,
          citedEvidence: null,
          assumptionsDisclosed: null,
        }),
        refusal: null,
      },
    },
  ],
};

describe("structured messageText (json_schema contract)", () => {
  it("legacy mode still surfaces tool args (synthetic draft-as-JSON mismatch family)", () => {
    const legacy = messageText(TOOL_ARGS_ONLY, "legacy");
    expect(legacy).toContain("Toyota");
    const parsed = parseScoutPlanText(legacy);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.kind).toBe("schema_mismatch");
      expect(parsed.message).toMatch(/^Missing reason or servStepId/);
    }
  });

  it("structured mode does not treat tool_call args as planner JSON", () => {
    expect(messageText(TOOL_ARGS_ONLY, "structured")).toBe("");
  });

  it("structured mode does not scrape incomplete reasoning drafts as planner JSON", () => {
    // Legacy could extract a JSON object missing reason/servStepId from the draft.
    const legacy = messageText(REASONING_DRAFT_ONLY, "legacy");
    expect(legacy).toContain("{");
    const legacyParsed = parseScoutPlanText(legacy);
    expect(legacyParsed.ok).toBe(false);
    if (!legacyParsed.ok) expect(legacyParsed.kind).toBe("schema_mismatch");

    expect(messageText(REASONING_DRAFT_ONLY, "structured")).toBe("");
  });

  it("structured mode still accepts content + refusal", () => {
    expect(messageText(VALID_ABSTAIN_CONTENT, "structured")).toContain("abstain");
    const refusal = messageText(
      {
        choices: [{ message: { content: null, refusal: "I cannot assist with that request." } }],
      },
      "structured",
    );
    expect(refusal.toLowerCase()).toContain("cannot assist");
  });
});

describe("scout_plan runServ uses structured extraction (offline)", () => {
  it("tool_calls-only 200 is empty (not schema_mismatch text) under experiment", async () => {
    const result = await runServ(
      "scout_plan",
      { user: "{}" },
      experimentServDeps({
        apiKey: "test-key",
        baseUrl: "https://serv-mock.test/v1",
        fetch: async () =>
          new Response(JSON.stringify(TOOL_ARGS_ONLY), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      }),
    );
    expect(result.httpAttempts).toBe(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/empty/i);
      expect(result.status).toBe(200);
    }
  });

  it("production empty-text recovery can recover after tool_calls-only first turn", async () => {
    expect(profile("scout_plan").jsonSchema?.name).toBe("lemonless_scout_plan_action");
    let calls = 0;
    const result = await runServ(
      "scout_plan",
      { user: "{}" },
      {
        apiKey: "test-key",
        baseUrl: "https://serv-mock.test/v1",
        // default transportPolicy=production → postProse empty retry
        fetch: async () => {
          calls += 1;
          const body = calls === 1 ? TOOL_ARGS_ONLY : VALID_ABSTAIN_CONTENT;
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      },
    );
    expect(calls).toBe(2);
    expect(result.httpAttempts).toBe(2);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const parsed = parseScoutPlanText(result.text);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.action.type).toBe("abstain");
    }
  });

  it("reasoning-draft-only 200 is empty under experiment (no draft-as-JSON false positive)", async () => {
    const result = await runServ(
      "scout_plan",
      { user: "{}" },
      experimentServDeps({
        apiKey: "test-key",
        baseUrl: "https://serv-mock.test/v1",
        fetch: async () =>
          new Response(JSON.stringify(REASONING_DRAFT_ONLY), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/empty/i);
      expect(result.status).toBe(200);
    }
  });
});
