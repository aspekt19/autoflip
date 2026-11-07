/**
 * Offline fixtures for Luna-era compare diagnosis (t299).
 * Isolated shapes only — no reconstructed live Luna JSON, no provider calls.
 */
import { describe, expect, it } from "vitest";
import { messageText } from "@/server/serv/run";
import {
  parseScoutPlanText,
  sanitizePlannerParseEcho,
} from "./plan-parse";

describe("scout plan parse diagnostics (offline fixtures)", () => {
  it("distinguishes wrong-shape / null / empty / missing under the same historical prefix", () => {
    const flip = parseScoutPlanText(
      JSON.stringify({ decisions: [{ vin: "X", verdict: "alert", note: "looks good" }] }),
    );
    expect(flip.ok).toBe(false);
    if (!flip.ok) {
      expect(flip.kind).toBe("schema_mismatch");
      expect(flip.message).toMatch(/^Missing reason or servStepId/);
      expect(flip.message).toContain("reason=missing");
      expect(flip.message).toContain("servStepId=missing");
      expect(flip.message).toContain("keys=decisions");
    }

    const nulls = parseScoutPlanText(
      JSON.stringify({ type: "abstain", reason: null, servStepId: null }),
    );
    expect(nulls.ok).toBe(false);
    if (!nulls.ok) {
      expect(nulls.message).toContain("reason=null");
      expect(nulls.message).toContain("servStepId=null");
      expect(nulls.message).toContain("type=string");
    }

    const empty = parseScoutPlanText(
      JSON.stringify({ type: "abstain", reason: "", servStepId: "   " }),
    );
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.message).toContain("reason=empty_string");
      expect(empty.message).toContain("servStepId=empty_string");
    }

    const nested = parseScoutPlanText(
      JSON.stringify({ action: { type: "abstain", reason: "ok", servStepId: "a1" } }),
    );
    expect(nested.ok).toBe(false);
    if (!nested.ok) {
      expect(nested.message).toContain("reason=missing");
      expect(nested.message).toContain("keys=action");
    }
  });

  it("sanitizePlannerParseEcho never embeds string values", () => {
    const secretReason = "SECRET_REASON_DO_NOT_PERSIST";
    const secretVin = "4T1KZ1AK4MU060006";
    const echo = sanitizePlannerParseEcho(
      JSON.stringify({
        type: "reject",
        reason: secretReason,
        servStepId: "step-secret",
        vin: secretVin,
        toolId: null,
      }),
    );
    expect(echo.looksLikeJsonObject).toBe(true);
    expect(echo.fieldPresence.reason).toBe("string");
    expect(echo.fieldPresence.servStepId).toBe("string");
    expect(echo.stringLengths.reason).toBe(secretReason.length);
    expect(echo.stringLengths.vin).toBe(secretVin.length);
    const blob = JSON.stringify(echo);
    expect(blob).not.toContain(secretReason);
    expect(blob).not.toContain(secretVin);
    expect(blob).not.toContain("step-secret");
  });

  it("documents messageText→parse hazard: tool_call args without reason/servStepId", () => {
    // Hypothesis only: if a model emits tool_calls instead of json_schema content,
    // messageText may surface args JSON that fails with the same mismatch family.
    const text = messageText({
      choices: [
        {
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
    });
    expect(text).toContain("Toyota");
    const parsed = parseScoutPlanText(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.kind).toBe("schema_mismatch");
      expect(parsed.message).toMatch(/^Missing reason or servStepId/);
      expect(parsed.message).toContain("reason=missing");
      expect(parsed.message).toContain("keys=");
    }
    const echo = sanitizePlannerParseEcho(text);
    expect(echo.topLevelKeys).toEqual(
      expect.arrayContaining(["distanceMiles", "makes", "models", "zip"]),
    );
    expect(JSON.stringify(echo)).not.toContain("Toyota");
  });

  it("still accepts a grounded abstain with non-empty reason + servStepId", () => {
    const parsed = parseScoutPlanText(
      JSON.stringify({
        type: "abstain",
        reason: "no verified options with usable asking prices",
        servStepId: "a1",
        vin: null,
        toolId: null,
        args: null,
        rationaleKind: null,
        citedEvidence: null,
        assumptionsDisclosed: null,
      }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.action.type).toBe("abstain");
  });
});
