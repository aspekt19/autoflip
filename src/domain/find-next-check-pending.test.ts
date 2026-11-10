import { describe, expect, it } from "vitest";
import {
  findNextCheckPendingLabel,
  LEGACY_PUBLIC_SAFETY_SPINNER,
} from "./find-next-check-pending";

describe("findNextCheckPendingLabel", () => {
  it("shows the current progress line while a hop is pending", () => {
    expect(
      findNextCheckPendingLabel({
        pending: true,
        progressLine: "Checked fuel economy for 3 models. Another check will run.",
      }),
    ).toBe("Checked fuel economy for 3 models. Another check will run.");
  });

  it("on pause/failure shows the real reason, not the legacy spinner", () => {
    const reason = "Automatic public checks paused after many steps. Nothing else is running.";
    expect(
      findNextCheckPendingLabel({
        pending: false,
        terminalReason: reason,
        progressLine: LEGACY_PUBLIC_SAFETY_SPINNER,
      }),
    ).toBe(reason);
    expect(LEGACY_PUBLIC_SAFETY_SPINNER).toMatch(/public safety/);
  });

  it("clears pending on terminal idle", () => {
    expect(findNextCheckPendingLabel({ pending: false })).toBeNull();
  });
});
