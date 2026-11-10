import { describe, expect, it } from "vitest";
import type { WatchAlert } from "./radar-watch";

/** Mirrors feed route filters — keep in sync with /api/radar/feed. */
function partitionAlerts(alerts: Array<Pick<WatchAlert, "status">>) {
  return {
    alerts: alerts.filter((item) => item.status === "new" || item.status === "opened"),
    servSkipped: alerts.filter((item) => item.status === "serv_skipped"),
    dismissed: alerts.filter((item) => item.status === "skipped"),
    notReviewed: alerts.filter((item) => item.status === "not_reviewed"),
  };
}

describe("Radar alert status partitions", () => {
  it("keeps buyer dismissals out of Reviewed — skipped", () => {
    const rows = [
      { status: "new" as const },
      { status: "opened" as const },
      { status: "skipped" as const },
      { status: "serv_skipped" as const },
      { status: "not_reviewed" as const },
    ];
    const parts = partitionAlerts(rows);
    expect(parts.alerts).toHaveLength(2);
    expect(parts.servSkipped).toHaveLength(1);
    expect(parts.dismissed).toHaveLength(1);
    expect(parts.notReviewed).toHaveLength(1);
    expect(parts.alerts.every((row) => row.status === "new" || row.status === "opened")).toBe(true);
    expect(parts.servSkipped[0]?.status).toBe("serv_skipped");
    expect(parts.dismissed[0]?.status).toBe("skipped");
  });
});
