import { describe, expect, it } from "vitest";
import {
  parseCityStatePhrase,
  resolveLocationZip,
  zipFieldMark,
  zipForCityState,
} from "./city-to-zip";

describe("city-to-zip", () => {
  it("parses Columbus OH and resolves to a Columbus ZIP", () => {
    expect(parseCityStatePhrase("Columbus OH")).toEqual({ city: "columbus", state: "OH" });
    expect(zipForCityState("columbus", "OH")).toBe("43215");
    const resolved = resolveLocationZip({ zip: null, locationPhrase: "Columbus OH" });
    expect(resolved).toEqual({
      zip: "43215",
      from: "inferred_from_city",
      needed: false,
      cityLabel: "Columbus, OH",
    });
    expect(zipFieldMark(resolved)).toBe("near Columbus, OH (inferred)");
  });

  it("keeps an explicit note ZIP and marks from your note", () => {
    const resolved = resolveLocationZip({ zip: "68114", locationPhrase: "Columbus OH" });
    expect(resolved.from).toBe("note_zip");
    expect(resolved.zip).toBe("68114");
    expect(zipFieldMark(resolved)).toBe("from your note");
  });

  it("marks needed when a place cannot be resolved", () => {
    const resolved = resolveLocationZip({ zip: null, locationPhrase: "Somewhereville ZZ" });
    expect(resolved.zip).toBeNull();
    expect(resolved.needed).toBe(true);
    expect(zipFieldMark(resolved)).toBe("needed");
  });

  it("treats near me as optional ZIP (not needed) with nationwide when blank", () => {
    const resolved = resolveLocationZip({ zip: null, locationPhrase: "near me" });
    expect(resolved.zip).toBeNull();
    expect(resolved.needed).toBe(false);
    expect(resolved.cityLabel).toBe("near me");
    expect(zipFieldMark(resolved)).toBeNull();
  });
});
