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
import { normalizeCompareUsage } from "./plan-parse-diagnostics";

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
      // Empty model servStepId alone is no longer a decision failure; reason empty is.
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

  it("Sonnet empty_string servStepId class: reason+type valid → execution binds correlation id", () => {
    // Parent PR71 schemafix probe (625bd8d): HTTP 200, reason present, servStepId "".
    // Correlation is execution-owned — must not reject a grounded decision for bookkeeping.
    const parsed = parseScoutPlanText(
      JSON.stringify({
        type: "abstain",
        reason:
          "All 20 pending asks are unusable (placeholder/fee/suspicious) — no genuine purchase-price evidence; free-gov cannot unlock investigation.",
        servStepId: "",
        vin: null,
        toolId: null,
        args: null,
        rationaleKind: null,
        citedEvidence: null,
        assumptionsDisclosed: null,
      }),
      { executionServStepId: "exec:step-1" },
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.action.type).toBe("abstain");
      expect(parsed.action.servStepId).toBe("exec:step-1");
      expect(parsed.action.reason.length).toBeGreaterThan(0);
    }
  });

  it("ignores model-emitted servStepId — execution ownership is authoritative", () => {
    const parsed = parseScoutPlanText(
      JSON.stringify({
        type: "finalize",
        reason: "investigation complete",
        servStepId: "model-invented-a1",
        vin: null,
        toolId: null,
        args: null,
        rationaleKind: null,
        citedEvidence: null,
        assumptionsDisclosed: null,
      }),
      { executionServStepId: "exec:step-7" },
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.action.servStepId).toBe("exec:step-7");
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

  it("documents legacy messageText→parse hazard; structured mode refuses tool_call args", () => {
    // Synthetic draft-as-JSON hazard (offline only — not proven live Luna RCA).
    // Pre-fix: legacy extraction surfaced args JSON → schema_mismatch family.
    // Post-fix: structured mode (json_schema profiles) returns empty instead.
    const payload = {
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
    };
    const legacy = messageText(payload, "legacy");
    expect(legacy).toContain("Toyota");
    const parsed = parseScoutPlanText(legacy);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.kind).toBe("schema_mismatch");
      expect(parsed.message).toMatch(/^Missing reason or servStepId/);
      expect(parsed.message).toContain("reason=missing");
      expect(parsed.message).toContain("keys=");
    }
    const echo = sanitizePlannerParseEcho(legacy);
    expect(echo.topLevelKeys).toEqual(
      expect.arrayContaining(["distanceMiles", "makes", "models", "zip"]),
    );
    expect(JSON.stringify(echo)).not.toContain("Toyota");
    expect(messageText(payload, "structured")).toBe("");
  });

  it("still accepts a grounded abstain with non-empty reason (servStepId execution-bound)", () => {
    const parsed = parseScoutPlanText(
      JSON.stringify({
        type: "abstain",
        reason: "no verified options with usable asking prices",
        vin: null,
        toolId: null,
        args: null,
        rationaleKind: null,
        citedEvidence: null,
        assumptionsDisclosed: null,
      }),
      { executionServStepId: "exec:step-3" },
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.action.type).toBe("abstain");
      expect(parsed.action.servStepId).toBe("exec:step-3");
    }
  });

  it("classifies Mini-style refusal prose (no JSON) without storing the prose", () => {
    // Parent Mini compare (Nov 8 Istanbul): step after_one_denied_reject → parseKind refusal.
    // Raw text absent from saved rows — fixture uses allowlisted marker phrasing only.
    const refusal = "I cannot assist with that request.";
    const parsed = parseScoutPlanText(refusal);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.kind).toBe("refusal");
      expect(parsed.message).toBe("SERV planner response looks like a refusal (not schema JSON).");
    }
    const echo = sanitizePlannerParseEcho(refusal);
    expect(echo.looksLikeJsonObject).toBe(false);
    expect(echo.looksLikeRefusalProse).toBe(true);
    expect(echo.textBytes).toBe(Buffer.byteLength(refusal, "utf8"));
    expect(JSON.stringify(echo)).not.toContain("cannot assist");
  });

  it("messageText refusal field surfaces as refusal-class parse (transport→parser)", () => {
    const text = messageText({
      choices: [
        {
          message: {
            content: null,
            refusal: "I can't assist with that.",
          },
        },
      ],
    });
    expect(text.toLowerCase()).toContain("can't assist");
    const parsed = parseScoutPlanText(text);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.kind).toBe("refusal");
  });

  it("treats all-zero token usage as unknown (not free) — Mini refusal accounting", () => {
    expect(normalizeCompareUsage({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })).toBeNull();
    expect(normalizeCompareUsage({ prompt_tokens: 3461, completion_tokens: 201, total_tokens: 3662 })).toEqual({
      prompt_tokens: 3461,
      completion_tokens: 201,
      total_tokens: 3662,
    });
  });
});
