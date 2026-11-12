import { describe, expect, it } from "vitest";
import { attachNoteGeo, noteMarksFrom, needFromFindEntry, findStageAfterNote } from "./find-intake-stage";
import { emptyNeed } from "./need";

describe("find intake stage — no note→constraint parsers", () => {
  it("needFromFindEntry keeps only caller ZIP/radius, never invents from free text", () => {
    const need = needFromFindEntry({
      note: "reliable SUV under $15k near Columbus OH",
      mode: "personal",
      zip: "43215",
      distanceMiles: 50,
    });
    expect(need.note).toMatch(/reliable SUV/);
    expect(need.budgetUsd).toBeNull();
    expect(need.budgetKnown).toBe(false);
    expect(need.zip).toBe("43215");
    expect(need.distanceMiles).toBe(50);
  });

  it("noteMarksFrom never claims structured fields came from note regex", () => {
    const need = {
      ...emptyNeed("personal"),
      note: "under $12k near 43215",
      budgetUsd: 12_000,
      budgetKnown: true,
      zip: "43215",
    };
    expect(noteMarksFrom(need)).toEqual({
      budget: false,
      use: false,
      year: false,
      miles: false,
      zip: false,
      location: false,
      transmission: false,
      fuel: false,
      awd: false,
      reliability: false,
      history: false,
      body: false,
    });
  });

  it("attachNoteGeo resolves city phrase already on need; never invents default radius", () => {
    const need = {
      ...emptyNeed("personal"),
      note: "family SUV",
      locationPhrase: "Columbus OH",
      zip: null,
      distanceMiles: null,
    };
    const withGeo = attachNoteGeo(need);
    expect(withGeo.distanceMiles).toBeNull();
    expect(withGeo.radiusIsDefault).toBe(false);
    expect(withGeo.locationResolution).toBeTruthy();
  });

  it("findStageAfterNote asks budget when unknown", () => {
    expect(findStageAfterNote(emptyNeed("personal"))).toBe("budget");
  });
});
