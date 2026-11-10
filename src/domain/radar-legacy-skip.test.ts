import { describe, expect, it } from "vitest";
import {
  countNewRadarAlertsInWindow,
  looksLikeLegacyServSkip,
  remapLegacyServSkipAlert,
  remapLegacyServSkipAlerts,
} from "./radar-legacy-skip";

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

  it("counts last-run alerts from remapped rows so legacy SERV skips do not inflate the header", () => {
    const startedAt = "2026-11-10T04:00:00.000Z";
    const remapped = remapLegacyServSkipAlerts([
      {
        ownerId: "u1",
        searchId: "s1",
        status: "new" as const,
        createdAt: "2026-11-10T04:01:00.000Z",
        why: "Fair ask — worth a look.",
      },
      {
        ownerId: "u1",
        searchId: "s1",
        status: "new" as const,
        createdAt: "2026-11-10T04:02:00.000Z",
        why: "Review note (does not cancel this alert): Margin below floor for a 2007 RAV4.",
      },
    ]);
    expect(remapped.map((row) => row.status)).toEqual(["new", "serv_skipped"]);
    expect(
      countNewRadarAlertsInWindow(remapped, {
        ownerId: "u1",
        searchIds: new Set(["s1"]),
        startedAt,
      }),
    ).toBe(1);
  });
});
