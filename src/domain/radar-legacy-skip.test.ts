import { describe, expect, it } from "vitest";
import { looksLikeLegacyServSkip, remapLegacyServSkipAlert } from "./radar-legacy-skip";

describe("remapLegacyServSkipAlert", () => {
  it("promotes legacy SERV-skip copy on new alerts to serv_skipped", () => {
    const legacy = {
      status: "new" as const,
      why: "Mid profit thin. Review note (does not cancel this alert): Margin below floor for a 2007 RAV4.",
    };
    expect(looksLikeLegacyServSkip(legacy.why)).toBe(true);
    expect(remapLegacyServSkipAlert(legacy).status).toBe("serv_skipped");
  });

  it("promotes Reviewed — skipped wording still stored as new", () => {
    const row = {
      status: "new" as const,
      why: "Reviewed — skipped: Thin comps for this ask.",
    };
    expect(remapLegacyServSkipAlert(row).status).toBe("serv_skipped");
  });

  it("leaves buyer dismissals and true new alerts alone", () => {
    expect(
      remapLegacyServSkipAlert({ status: "skipped" as const, why: "Buyer dismissed." }).status,
    ).toBe("skipped");
    expect(
      remapLegacyServSkipAlert({
        status: "new" as const,
        why: "Fair ask vs similar listings — alert worthy.",
      }).status,
    ).toBe("new");
  });
});
