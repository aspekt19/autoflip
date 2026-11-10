import { describe, expect, it } from "vitest";
import { attachNoteGeo, noteMarksFrom } from "./find-intake-stage";
import { explicitNeedFromText } from "./need";
import { zipFieldMark } from "./city-to-zip";

describe("fresh free-text geo honesty", () => {
  it("resolves Columbus OH to a ZIP and never marks a stale wizard ZIP as from your note", () => {
    const note = "sedan for commute in Columbus OH, under $15k, under 100k miles";
    const parsed = explicitNeedFromText(note, "personal");
    expect(parsed.useCase).toBe("commute");
    expect(parsed.zip).toBeNull();
    expect(parsed.locationPhrase).toMatch(/Columbus/i);

    // Stale wizard ZIP must not win over the note's city.
    const stale = { ...parsed, zip: "68114" };
    const attached = attachNoteGeo(
      { ...stale, zip: null, locationPhrase: parsed.locationPhrase },
      { applyDefaultRadius: true },
    );
    expect(attached.zip).toBe("43215");
    expect(attached.distanceMiles).toBe(100);
    expect(attached.radiusIsDefault).toBe(true);
    expect(zipFieldMark(attached.locationResolution)).toBe("near Columbus, OH (inferred)");

    const marks = noteMarksFrom({ ...attached, zip: "43215" }, note);
    expect(marks.zip).toBe(false); // digits were not in the note
    expect(marks.use).toBe(true);
    expect(marks.budget).toBe(true);
  });

  it("marks ZIP from your note only when digits appear in the note", () => {
    const note = "SUV near 68114 under $20k";
    const parsed = explicitNeedFromText(note, "personal");
    expect(parsed.zip).toBe("68114");
    expect(noteMarksFrom(parsed, note).zip).toBe(true);
  });
});
