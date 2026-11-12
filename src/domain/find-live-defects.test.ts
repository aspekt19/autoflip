import { describe, expect, it } from "vitest";
import { explicitNeedFromText } from "./need";
import { budgetFromText, milesCapFromNote, awdLimitFromText } from "./note-intake";
import { buildSearchSpec } from "./search-spec";
import { proposeDirections } from "./directions";
import { isPassengerOrLightTruck, passengerBodyStyleParam } from "./passenger-vehicle";
import { orderedYearBounds, yearSpanSentence } from "./year-span";
import { freshVisitRestorePolicy } from "./af-flow-session";

const CASE_A =
  "First car for my daughter, safe and cheap to run, max 12k, near Chicago, newer than 2019";

describe("live Find defects — note reading", () => {
  it("reads a single max Nk next to a budget as price only", () => {
    expect(budgetFromText(CASE_A)).toBe(12_000);
    expect(milesCapFromNote(CASE_A)).toBeNull();
    expect(milesCapFromNote("max 50k")).toBeNull();
    expect(milesCapFromNote("under 80k miles")).toBe(80_000);
    expect(milesCapFromNote("odometer under 60k")).toBe(60_000);
    const spec = buildSearchSpec({ note: CASE_A });
    expect(spec.hard.priceMaxUsd?.value).toBe(12_000);
    expect(spec.hard.milesMax).toBeUndefined();
    expect(spec.hard.yearMin?.value).toBe(2020);
    const yearMin = spec.hard.yearMin?.value ?? 0;
    expect(spec.hard.yearMax == null || spec.hard.yearMax.value >= yearMin).toBe(true);
  });

  it("treats explicit with AWD as a hard limit and preferably AWD as soft", () => {
    const hard = "Used compact SUV with AWD under $25,000 near Denver, 2018 or newer, under 80k miles";
    expect(awdLimitFromText(hard)).toBe("hard");
    expect(buildSearchSpec({ note: hard }).hard.drivetrain?.value).toBe("awd_4wd");
    const need = explicitNeedFromText(hard, "personal");
    expect(need.awdPreference).toBe(true);
    expect(need.mustHaves).toContain("AWD");

    expect(awdLimitFromText("Preferably AWD, under 70k miles")).toBe("soft");
    expect(buildSearchSpec({ note: "Family SUV under $20k, preferably AWD" }).hard.drivetrain).toBeUndefined();
    expect(explicitNeedFromText("Preferably AWD SUV under $20k", "personal").mustHaves).not.toContain("AWD");
  });

  it("never renders a year floor above the ceiling", () => {
    const need = explicitNeedFromText(CASE_A, "personal");
    need.budgetUsd = 12_000;
    need.budgetKnown = true;
    const direction = proposeDirections(need, undefined, new Date("2026-11-12T00:00:00Z"))[0];
    expect(direction).toBeTruthy();
    expect(direction!.yearMin).toBeLessThanOrEqual(direction!.yearMax);
    expect(yearSpanSentence(direction!.yearMin, direction!.yearMax)).not.toMatch(/2020–2019|2020-2019/);
    expect(yearSpanSentence(2020, 2019)).toBe("Oldest year 2020.");
    expect(orderedYearBounds(2020, 2019, false, 2027)).toEqual({ yearMin: 2020, yearMax: 2027 });
  });

  it("keeps motorcycles and RVs out of a passenger search", () => {
    expect(isPassengerOrLightTruck({ make: "Honda", model: "Civic", bodyStyle: "Sedan" })).toBe(true);
    expect(isPassengerOrLightTruck({ make: "Ford", model: "F-150", bodyStyle: "Truck" })).toBe(true);
    expect(isPassengerOrLightTruck({ make: "Harley-Davidson", model: "Nightster", bodyStyle: "Motorcycle" })).toBe(false);
    expect(isPassengerOrLightTruck({ make: "Ducati", model: "Monster", bodyStyle: null })).toBe(false);
    expect(isPassengerOrLightTruck({ make: "Yamaha", model: "MT-07", bodyStyle: null })).toBe(false);
    expect(isPassengerOrLightTruck({ make: "Kawasaki", model: "Vulcan", bodyStyle: "Motorcycle" })).toBe(false);
    expect(isPassengerOrLightTruck({ make: "Coachman", model: "Clipper", bodyStyle: "RV" })).toBe(false);
    expect(passengerBodyStyleParam(undefined)).toMatch(/Sedan/);
    expect(passengerBodyStyleParam(undefined)).not.toMatch(/Motorcycle/);
    expect(passengerBodyStyleParam("SUV")).toBe("SUV");
  });

  it("starts a fresh Find visit blank and offers resume instead of restoring", () => {
    expect(freshVisitRestorePolicy()).toEqual({
      autoApply: false,
      resumeLabel: "Resume last search",
    });
  });
});
