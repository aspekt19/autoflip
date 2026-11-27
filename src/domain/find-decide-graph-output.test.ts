import { describe, expect, it } from "vitest";
import { validateFindChallenge, validateFindDecide } from "./find-decide";
import { parseFindDecideGraphOutput } from "./find-decide-graph-output";

const A = "1HGCV1F30LA000001";
const B = "4T1B11HK5KU000002";
const ctx = {
  shortlistKeys: [A, B],
  allowedEvidenceIds: [`car:${A}`, `car:${B}`, `fair:${A}`],
  askUsd: 21_000,
  fairValueUsd: null,
  fairValueLowUsd: null,
  fairValueHighUsd: null,
};

describe("parseFindDecideGraphOutput", () => {
  it("reads the compact four-line reply and passes the validators", () => {
    const text = [
      `**Pick:** ${A}`,
      "Action: inspect first",
      "Confidence: Medium",
      "Review: kept",
      `The Accord has fewer miles than the Camry and no reported accident (car:${A}, car:${B}). Its price could not be compared with similar cars, so check the service history (fair:${A}).`,
    ].join("\n");
    const out = parseFindDecideGraphOutput(text)!;
    expect(out).not.toBeNull();
    const decide = validateFindDecide(out.decide, ctx);
    expect(decide.ok).toBe(true);
    if (!decide.ok) return;
    expect(decide.decide.pickKey).toBe(A);
    expect(decide.decide.action).toBe("inspect_first");
    expect(decide.decide.confidence).toBe("medium");
    expect(decide.decide.reasons[0]?.evidenceIds).toEqual(expect.arrayContaining([`car:${A}`, `fair:${A}`]));
    const challenge = validateFindChallenge(out.challenge, ctx);
    expect(challenge.ok && challenge.challenge.agree).toBe(true);
  });

  it("maps 'Review: revised' to a challenge issue without a second revision", () => {
    const text = `Pick: ${B}\nAction: negotiate\nConfidence: low\nReview: revised — the Camry asks less than the Accord\nAsks less (car:${B}).`;
    const out = parseFindDecideGraphOutput(text)!;
    const challenge = validateFindChallenge(out.challenge, ctx);
    expect(challenge.ok).toBe(true);
    if (!challenge.ok) return;
    expect(challenge.challenge.agree).toBe(false);
    expect(challenge.challenge.issues[0]?.text).toMatch(/Camry asks less/);
    expect(challenge.challenge.revised).toEqual({ pickKey: null, action: null, confidence: null });
  });

  it("reads generator-shaped JSON and prefers the final answer", () => {
    const json = {
      initial: { pickKey: B, action: "buy", confidence: "high" },
      final: { pickKey: A, action: "negotiate", confidence: "medium", reason: "Fewer miles.", evidenceIds: [`car:${A}`] },
      review: "revised",
    };
    const out = parseFindDecideGraphOutput(JSON.stringify(json))!;
    const decide = validateFindDecide(out.decide, ctx);
    expect(decide.ok && decide.decide.pickKey).toBe(A);
    expect(decide.ok && decide.decide.action).toBe("negotiate");
  });

  it("keeps the legacy { decide, challenge } object", () => {
    const legacy = { decide: { pickKey: A }, challenge: { agree: true } };
    expect(parseFindDecideGraphOutput(JSON.stringify(legacy))).toEqual(legacy);
  });

  it("returns null when pick, action or confidence is missing", () => {
    expect(parseFindDecideGraphOutput("The Accord looks good.")).toBeNull();
    expect(parseFindDecideGraphOutput(`Pick: ${A}\nAction: buy`)).toBeNull();
    expect(parseFindDecideGraphOutput("")).toBeNull();
  });

  it("strips the trailing Evidence line from the reason and keeps its ids", () => {
    const text = `Pick: ${A}\nAction: negotiate\nConfidence: medium\nReview: kept\nAsks above fair value; offer near it.\nEvidence: car:${A}, fair:${A}`;
    const out = parseFindDecideGraphOutput(text)!;
    const decide = out.decide as { reasons: Array<{ text: string; evidenceIds: string[] }>; confidenceWhy: string };
    expect(decide.reasons[0]!.text).toBe("Asks above fair value; offer near it.");
    expect(decide.confidenceWhy).not.toMatch(/Evidence/);
    expect(decide.reasons[0]!.evidenceIds).toEqual(expect.arrayContaining([`car:${A}`, `fair:${A}`]));
  });
});
