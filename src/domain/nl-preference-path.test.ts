/**
 * Broader NL preference path regressions (t314).
 * Acceptance notes are examples — paraphrase / negation / soft-vs-strict covered here.
 */
import { describe, expect, it } from "vitest";
import { proposeDirections } from "./directions";
import {
  closedToOtherMakesFromText,
  explicitNeedFromText,
  preferOpenToOtherMakes,
  preferredModelsFromText,
  softPrefGapsFromText,
} from "./need";

describe("NL preference path — soft vs strict", () => {
  const paraphrasesOpen = [
    "Family SUV around 20k. Considering a Mazda CX-5 or Toyota RAV4.",
    "Comparing the Honda CR-V, Hyundai Tucson and Kia Sportage for city + weekend trips under $15,000.",
    "I've only been looking at CR-Vs and RAV4s so far but have not decided.",
    "Between a Tucson and a Sportage near $15k — which is the better deal?",
  ];

  for (const note of paraphrasesOpen) {
    it(`keeps named models as open preferences: ${note.slice(0, 48)}…`, () => {
      expect(closedToOtherMakesFromText(note)).toBe(false);
      const need = explicitNeedFromText(note, "personal");
      expect(need.openToOtherMakes).toBe(true);
      expect(preferOpenToOtherMakes(note, need.preferredMakes)).toBe(true);
      if (need.preferredModels.length >= 2) {
        const directions = proposeDirections(
          { ...need, zip: "68114", distanceMiles: 50, budgetUsd: need.budgetUsd ?? 20_000, budgetKnown: true },
          undefined,
          new Date("2026-11-08T00:00:00Z"),
        );
        expect(directions[0]?.models.length).toBeGreaterThanOrEqual(2);
        // Must not collapse to a single first-named search target for the named group.
        expect(directions[0]?.models.map((m) => m.model)).not.toEqual([directions[0]!.models[0]!.model]);
      }
    });
  }

  const paraphrasesClosed = [
    "I want only a Honda CR-V under $15,000. Not interested in other makes.",
    "Must be a Toyota RAV4 — nothing else.",
    "Restrict to these makes: Mazda only. Family SUV around 20k.",
    "Don't show me anything else — solely interested in a Kia Sportage.",
  ];

  for (const note of paraphrasesClosed) {
    it(`hard-closes when exclusion is explicit: ${note.slice(0, 48)}…`, () => {
      expect(closedToOtherMakesFromText(note)).toBe(true);
      const need = explicitNeedFromText(note, "personal");
      expect(need.openToOtherMakes).toBe(false);
      const directions = proposeDirections(
        { ...need, zip: "68114", distanceMiles: 50, budgetUsd: need.budgetUsd ?? 15_000, budgetKnown: true },
        undefined,
        new Date("2026-11-08T00:00:00Z"),
      );
      expect(directions.length).toBeGreaterThan(0);
      // Closed mandate: every searched model stays inside preferred makes (no silent open extras).
      const makes = new Set((need.preferredMakes.length ? need.preferredMakes : [need.make]).map((m) => m?.toLowerCase()));
      expect(
        directions.every((d) => d.models.every((m) => makes.has(m.make.toLowerCase()))),
      ).toBe(true);
    });
  }
});

describe("NL preference path — soft prefs and budget tradeoffs", () => {
  it("treats ideally-AWD + unknown age + cheap-to-run as honesty gaps, not filters", () => {
    const note =
      "Reliable family crossover around $18,000. Ideally with AWD. Not too old. Reasonably cheap to run. Good condition matters more than squeezing the last dollar.";
    const need = explicitNeedFromText(note, "personal");
    expect(need.budgetUsd).toBe(18_000);
    expect(need.openToOtherMakes).toBe(true);
    const gaps = softPrefGapsFromText(note);
    expect(gaps.map((g) => g.id).sort()).toEqual(["age", "awd", "fuel_or_running_cost", "history"]);
    expect(gaps.every((g) => /does not|not a|no hard|unavailable|missing history/i.test(g.honesty))).toBe(true);
  });

  it("extracts mixed named models without first-name exclusivity", () => {
    const note = "RAV4, CX-5, and maybe a Forester — family SUV near 20k.";
    const models = preferredModelsFromText(note);
    expect(models.map((m) => m.model).sort()).toEqual(["CX-5", "Forester", "RAV4"]);
    const need = explicitNeedFromText(note, "personal");
    const directions = proposeDirections(
      { ...need, zip: "68114", distanceMiles: 100, budgetUsd: 20_000, budgetKnown: true },
      undefined,
      new Date("2026-11-08T00:00:00Z"),
    );
    expect(directions[0]?.models.map((m) => m.model).sort()).toEqual(["CX-5", "Forester", "RAV4"]);
    expect(directions[0]?.search).toEqual(models[0]);
  });

  it("negation of openness still closes", () => {
    const note = "Looking at Mazda CX-5 and Toyota RAV4 but not interested in other makes.";
    expect(closedToOtherMakesFromText(note)).toBe(true);
    expect(explicitNeedFromText(note, "personal").openToOtherMakes).toBe(false);
  });
});
