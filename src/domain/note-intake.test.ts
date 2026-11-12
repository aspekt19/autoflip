import { describe, expect, it } from "vitest";
import { explicitNeedFromText, followUps, milesFromText } from "./need";
import { bodyFromIntake, budgetFromText, intakeFromNote, locationPhraseFromText, yearsFromNote } from "./note-intake";
import { findStageAfterNote } from "./find-intake-stage";

const REPRO =
  "Looking for a reliable used car for myself, budget around $15k, automatic, good on gas, nothing salvage or with accident history.";

describe("note limits that are easy to miss", () => {
  it("reads a body word, a city area, and nothing-older-than", () => {
    expect(bodyFromIntake("truck for work, can tow a trailer")).toBe("Truck");
    expect(bodyFromIntake("a minivan for the kids")).toBe("Minivan");
    expect(bodyFromIntake("looking for a convertible for weekends")).toBe("Convertible");
    expect(bodyFromIntake("convertible coupe")).toBe("Convertible");
    expect(locationPhraseFromText("truck for work, atlanta area, can tow a trailer")).toBe("atlanta");
    expect(locationPhraseFromText("near San Diego under $15k")).toBe("San Diego");
    expect(yearsFromNote("nothing older than 2015").yearMin).toBe(2015);
  });

  it("captures 3rd-row / seats and low-miles preference from the note", () => {
    const third = intakeFromNote("Family SUV with a 3rd row under $25k");
    expect(third.seatsMin).toBe(7);
    expect(intakeFromNote("Need a third row or 7 seats").seatsMin).toBe(7);
    expect(intakeFromNote("7-seater for the kids").seatsMin).toBe(7);
    const low = intakeFromNote("Reliable sedan, low mileage, around $12k");
    expect(low.milesMax).toBeNull();
    expect(low.priorities).toEqual(expect.arrayContaining(["low_miles"]));
    const need = explicitNeedFromText("Reliable sedan, low miles, around $12k", "personal");
    expect(need.priorities).toEqual(expect.arrayContaining(["low_miles"]));
    expect(need.milesCapResolved).toBe(false);
  });
});

describe("budget phrases the old regex dropped", () => {
  it("reads $15k, 15,000, and under 15k", () => {
    expect(budgetFromText(REPRO)).toBe(15_000);
    expect(budgetFromText("under 15k")).toBe(15_000);
    expect(budgetFromText("under $15k")).toBe(15_000);
    expect(budgetFromText("15,000")).toBe(15_000);
    expect(budgetFromText("under 15,000")).toBe(15_000);
    expect(budgetFromText("budget 15000")).toBe(15_000);
    expect(budgetFromText("around $15,000")).toBe(15_000);
    expect(budgetFromText("~$15k")).toBe(15_000);
    expect(budgetFromText("Need a reliable family car under $18,000")).toBe(18_000);
    expect(budgetFromText("budget around $15k")).toBe(15_000);
    expect(budgetFromText("under 20 grand")).toBe(20_000);
    expect(budgetFromText("around 12-15k")).toBe(15_000);
    expect(budgetFromText("between $12,000 and $15,000")).toBe(15_000);
    expect(budgetFromText("Looking for a reliable used car for 15,000 dollars.")).toBe(15_000);
    expect(budgetFromText("Looking for a reliable used car under 20 grand.")).toBe(20_000);
    expect(budgetFromText("Looking for a reliable used car around 12-15k.")).toBe(15_000);
    expect(budgetFromText("need something reliable for commuting, around 15 grand, prefer a hybrid")).toBe(15_000);
    expect(budgetFromText("about fifteen thousand for a commuter")).toBe(15_000);
  });

  it("does not invent a budget or treat miles and model years as prices", () => {
    expect(budgetFromText("a reliable car for errands")).toBeNull();
    expect(budgetFromText("under 80k miles")).toBeNull();
    expect(budgetFromText("max 50k")).toBeNull();
    expect(budgetFromText("2015 or newer")).toBeNull();
    expect(budgetFromText("around 2015")).toBeNull();
    expect(milesFromText("under 15k")).toBeNull();
    expect(milesFromText("max 50k")).toBeNull();
    expect(milesFromText("max 50k miles")).toBe(50_000);
    expect(milesFromText("under 50k miles")).toBe(50_000);
  });
});

describe("owner find note", () => {
  it("prefills every fact the repro note already states and does not ask them again", () => {
    const intake = intakeFromNote(REPRO);
    expect(intake.budgetUsd).toBe(15_000);
    expect(intake.transmission).toBe("automatic");
    expect(intake.fuelEconomyPriority).toBe(true);
    expect(intake.historyPreference).toBe("no_salvage_no_accidents");
    expect(intake.bodyStyle).toBeNull();
    expect(intake.yearMin).toBeNull();
    expect(intake.milesMax).toBeNull();
    expect(intake.zip).toBeNull();
    expect(intake.locationPhrase).toBeNull();

    const need = explicitNeedFromText(REPRO, "personal");
    expect(need.useCase).toBe("unspecified");
    expect(need.budgetKnown).toBe(true);
    expect(need.budgetUsd).toBe(15_000);
    expect(need.conditionPriority).toBe("inspection_first");
    expect(need.transmission).toBe("automatic");
    expect(need.fuelEconomyPriority).toBe(true);
    expect(followUps(need)).toEqual([]);
    expect(findStageAfterNote(need)).toBe("confirm");
  });

  it("still asks age and condition when the note left them open", () => {
    const note =
      "I need a decent family car for around $15,000. Not too old. I'd rather pay a little more for a car in good condition.";
    const need = explicitNeedFromText(note, "personal");
    expect(need.budgetUsd).toBe(15_000);
    expect(need.historyPreference).toBeNull();
    expect(followUps(need).map((item) => item.id)).toEqual(expect.arrayContaining(["age", "condition"]));
    expect(findStageAfterNote(need)).toBe("follow");
  });

  it("does not ask the price again for grand, comma, and range budgets", () => {
    for (const [note, usd] of [
      ["Looking for a reliable used car under 20 grand.", 20_000],
      ["Looking for a reliable used car for 15,000 dollars.", 15_000],
      ["Looking for a reliable used car around 12-15k.", 15_000],
    ] as const) {
      const need = explicitNeedFromText(note, "personal");
      expect(need.budgetUsd).toBe(usd);
      expect(need.budgetKnown).toBe(true);
      expect(need.milesMax).toBeNull();
      expect(followUps(need).map((item) => item.id)).not.toContain("cash");
      expect(findStageAfterNote(need)).toBe("confirm");
    }
    const open = explicitNeedFromText("Looking for a reliable used car for errands.", "personal");
    expect(open.budgetUsd).toBeNull();
    expect(findStageAfterNote(open)).toBe("budget");
  });

  it("prefills body, year, mileage, ZIP, and radius when they are written", () => {
    const note = "Family SUV under $20k, automatic, 2016 or newer, under 80k miles, near 68114 within 50 miles.";
    const need = explicitNeedFromText(note, "personal");
    expect(need.useCase).toBe("family");
    expect(need.budgetUsd).toBe(20_000);
    expect(need.bodyStyle).toBe("SUV");
    expect(need.transmission).toBe("automatic");
    expect(need.yearMin).toBe(2016);
    expect(need.milesMax).toBe(80_000);
    expect(need.zip).toBe("68114");
    expect(need.distanceMiles).toBe(50);
    expect(need.locationPhrase).toBeNull();
  });

  it("keeps a city phrase without inventing a ZIP", () => {
    const need = explicitNeedFromText("Reliable sedan around $12,000 in Austin.", "personal");
    expect(need.locationPhrase).toBe("Austin");
    expect(need.zip).toBeNull();
    expect(need.distanceMiles).toBeNull();
    expect(need.bodyStyle).toBe("Sedan");
    expect(need.budgetUsd).toBe(12_000);
  });

  it("detects locationPhrase \"near me\" without inventing a ZIP or radius", () => {
    const note =
      "Looking for a used SUV around $20k. What are the best deals near me?";
    const intake = intakeFromNote(note);
    expect(intake.locationPhrase).toBe("near me");
    expect(intake.zip).toBeNull();
    expect(intake.distanceMiles).toBeNull();
    const need = explicitNeedFromText(note, "personal");
    expect(need.locationPhrase).toBe("near me");
    expect(need.zip).toBeNull();
    expect(need.distanceMiles).toBeNull();
  });

  it("keeps ZIP without inventing a radius (nationwide until Confirm)", () => {
    const need = explicitNeedFromText("Reliable sedan under $15,000 near 68114.", "personal");
    expect(need.zip).toBe("68114");
    expect(need.distanceMiles).toBeNull();
  });
});
