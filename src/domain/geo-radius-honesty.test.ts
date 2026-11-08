import { describe, expect, it } from "vitest";
import { searchScopeLabel, type StructuredNeed } from "@/domain/need";

/**
 * Confirm-step ZIP typing must not invent a radius after Nationwide.
 * Mirrors AssistantFlow onZipChange after the honesty fix.
 */
function applyZipAfterNationwide(
  need: Pick<StructuredNeed, "zip" | "distanceMiles">,
  nextZip: string,
): Pick<StructuredNeed, "zip" | "distanceMiles"> {
  const trimmed = nextZip.trim() || null;
  return {
    zip: trimmed,
    distanceMiles: trimmed ? need.distanceMiles : null,
  };
}

/** Watch save: require explicit radius — never invent 50/100. */
function watchRadiusMiles(need: Pick<StructuredNeed, "zip" | "distanceMiles" | "mode">): {
  ok: boolean;
  radiusMiles?: number;
  message?: string;
} {
  if (!need.zip?.trim() || need.distanceMiles == null) {
    return {
      ok: false,
      message:
        "Saved searches need a ZIP and a seller-distance radius. Choose a radius (Nationwide watches are not supported).",
    };
  }
  return { ok: true, radiusMiles: need.distanceMiles };
}

describe("geo radius honesty", () => {
  it("failure-first (old bug): Nationwide + typed ZIP must not become silent 100 mi", () => {
    const nationwide = { zip: null as string | null, distanceMiles: null as number | null };
    const next = applyZipAfterNationwide(nationwide, "68114");
    expect(next).toEqual({ zip: "68114", distanceMiles: null });
    expect(searchScopeLabel(next)).toBe("Nationwide (U.S.)");
    expect(next.distanceMiles).not.toBe(100);
  });

  it("keeps an explicit radius when ZIP is edited", () => {
    const local = { zip: "68114", distanceMiles: 50 };
    expect(applyZipAfterNationwide(local, "68114")).toEqual({ zip: "68114", distanceMiles: 50 });
    expect(applyZipAfterNationwide(local, "")).toEqual({ zip: null, distanceMiles: null });
  });

  it("failure-first: flip/personal watch must not invent 50/100 after Nationwide", () => {
    expect(watchRadiusMiles({ zip: "68114", distanceMiles: null, mode: "flip" }).ok).toBe(false);
    expect(watchRadiusMiles({ zip: "68114", distanceMiles: null, mode: "personal" }).ok).toBe(false);
    expect(watchRadiusMiles({ zip: "68114", distanceMiles: 50, mode: "flip" })).toEqual({
      ok: true,
      radiusMiles: 50,
    });
    expect(watchRadiusMiles({ zip: "68114", distanceMiles: 100, mode: "personal" })).toEqual({
      ok: true,
      radiusMiles: 100,
    });
  });
});
