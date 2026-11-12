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
  });

  it("structured mode does not treat tool_call args as planner JSON", () => {
    expect(messageText(TOOL_ARGS_ONLY, "structured")).toBe("");
  });

  it("structured mode does not scrape incomplete reasoning drafts as planner JSON", () => {
    // Legacy could extract a JSON object missing reason/servStepId from the draft.
    const legacy = messageText(REASONING_DRAFT_ONLY, "legacy");
    expect(legacy).toContain("{");

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
