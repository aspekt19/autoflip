import { describe, expect, it } from "vitest";

/** Same wording as /activity run titles. */
function activityRunTitle(startedAt: string, finishedAt: string): string {
  const started = new Date(startedAt).toLocaleString("en-US", { timeZone: "UTC" });
  const finished = new Date(finishedAt).toLocaleString("en-US", { timeZone: "UTC" });
  return `Started ${started} UTC · finished ${finished} UTC`;
}

describe("activity run title", () => {
  it("includes both started and finished timestamps", () => {
    const title = activityRunTitle("2026-11-10T05:13:57.000Z", "2026-11-10T05:14:47.000Z");
    expect(title).toMatch(/^Started /);
    expect(title).toMatch(/ · finished /);
    expect(title).toContain("UTC");
    expect(title).not.toBe(
      `${new Date("2026-11-10T05:13:57.000Z").toLocaleString("en-US", { timeZone: "UTC" })} UTC`,
    );
  });
});
