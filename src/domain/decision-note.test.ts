import { describe, expect, it } from "vitest";
import { quotedNumbersStayIn, whyWeDecided, type DecisionProof } from "./decision-note";

const banned = /\b(openserv|gpt-|serv_|kronos|multipath|shadow|json|hackathon|judges?|crypto|x402|kite|wallet)\b/i;

function proof(partial: Partial<DecisionProof> & Pick<DecisionProof, "purpose">): DecisionProof {
  return {
    tools: [],
    features: [],
    promptGuard: "not_used",
    shadowOutcome: "not_used",
    shadowMaxIterations: null,
    latencyMs: 10,
    ...partial,
  };
}

describe("why we decided", () => {
  it("turns recorded checks into plain language and does not invent a source name", () => {
    const paragraphs = whyWeDecided("flip", [
      proof({ purpose: "radar_guard", tools: ["serv_prompt_guard"], promptGuard: "allow" }),
      proof({ purpose: "flip_feasibility", tools: ["serv_prompt_guard", "serv_shadow_agent"], features: ["kronos"], shadowOutcome: "not_exposed", shadowMaxIterations: 2 }),
      proof({
        purpose: "flip_judge",
        tools: ["serv_prompt_guard", "serv_shadow_agent"],
        features: ["multipath"],
        jsonSchema: "flip_alert_judgment",
        promptGuard: "passed",
        shadowOutcome: "not_exposed",
        shadowMaxIterations: 2,
      }),
    ]);
    const text = paragraphs.join(" ");
    expect(text).toMatch(/safety check/i);
    expect(text).toMatch(/second pass/i);
    expect(text).toMatch(/more than one way/i);
    expect(text).toMatch(/fixed set of rules/i);
    expect(text).toMatch(/fixed form/i);
    expect(text).toMatch(/calculated/i);
    expect(text).not.toMatch(banned);
    expect(text).not.toMatch(/\{|\}/);
  });

  it("says the calculated result stands when no check was recorded", () => {
    const text = whyWeDecided("find", []).join(" ");
    expect(text).toMatch(/not recorded|missing or unusable|Nothing was invented/i);
    expect(text).not.toMatch(banned);
  });

  it("does not claim a blank budget stays blank when a note can name the price", () => {
    const text = whyWeDecided("find", [
      proof({ purpose: "find_guard", tools: ["serv_prompt_guard"], promptGuard: "allow" }),
    ]).join(" ");
    expect(text).not.toMatch(/blank budget stays blank/i);
    expect(text).toMatch(/price in your note is the budget/i);
    expect(text).toMatch(/around/i);
    expect(text).toMatch(/budget stays unset/i);
    expect(text).not.toMatch(banned);
  });

  it("rejects a sentence that introduces a number the facts do not contain", () => {
    expect(quotedNumbersStayIn("Estimate about $1,200 from 5 cars.", JSON.stringify({ profitMidUsd: 1200, compCount: 5 }))).toBe(true);
    expect(quotedNumbersStayIn("Profit near $9,999.", JSON.stringify({ profitMidUsd: 1200 }))).toBe(false);
  });

  it("uses exact numeric tokens instead of matching partial substrings", () => {
    expect(quotedNumbersStayIn("The offer is $15,000.", JSON.stringify({ priceUsd: 15000 }))).toBe(true);
    expect(quotedNumbersStayIn("The offer is $500.", JSON.stringify({ priceUsd: 15000 }))).toBe(false);
  });

  it("accepts numbers embedded in a supplied VIN and ZIP", () => {
    expect(
      quotedNumbersStayIn(
        "2021 Camry, VIN 4T1K61AK0MU423359, ZIP 02108.",
        JSON.stringify({ year: 2021, vin: "4T1K61AK0MU423359", zip: "02108" }),
      ),
    ).toBe(true);
  });

  it("preserves negative and positive signs in numeric evidence", () => {
    expect(quotedNumbersStayIn("Expected loss is -$300.", JSON.stringify({ profitMidUsd: -300 }))).toBe(true);
    expect(quotedNumbersStayIn("Expected gain is $300.", JSON.stringify({ profitMidUsd: -300 }))).toBe(false);
    expect(quotedNumbersStayIn("In 2020, the estimated loss is -$300.", JSON.stringify({ year: 2020, profitMidUsd: -300 }))).toBe(true);
  });

  it("treats a hyphen between currency amounts as a range separator", () => {
    const facts = JSON.stringify({ profitLowUsd: 400, profitHighUsd: 1400, profitMidUsd: 900 });
    expect(quotedNumbersStayIn("Estimated profit is $400-$1,400, with a $900 midpoint.", facts)).toBe(true);
    expect(quotedNumbersStayIn("Estimated profit is $400 - $1,400, with a $900 midpoint.", facts)).toBe(true);
  });

  it("treats a hyphen between plain numeric values as a range separator", () => {
    const facts = JSON.stringify({ profitLowUsd: 400, profitHighUsd: 1400, profitMidUsd: 900 });
    expect(quotedNumbersStayIn("Estimated profit range is 400-1400, midpoint 900.", facts)).toBe(true);
    expect(quotedNumbersStayIn("Estimated profit range is -800-100, midpoint -300.", JSON.stringify({ profitLowUsd: -800, profitHighUsd: 100, profitMidUsd: -300 }))).toBe(true);
  });

  it("does not treat VIN or model-code digits as standalone numeric evidence", () => {
    const facts = JSON.stringify({ vin: "4T1K61AK0MU423359", model: "CX-5", miles: 15000 });
    expect(quotedNumbersStayIn("VIN 4T1K61AK0MU423359, CX-5, 15,000 miles.", facts)).toBe(true);
    expect(quotedNumbersStayIn("VIN 4T1K61AK0MU423359, CX-5, 61 miles.", facts)).toBe(false);
  });
});
