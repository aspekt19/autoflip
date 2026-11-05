import { describe, expect, it } from "vitest";
import type { FullReport } from "@/domain/types";
import { MemoryKv } from "./kv";
import { listUserReports, rememberUserReport } from "./persist-report";

function report(id: string, vin: string, createdAt: string): FullReport {
  return {
    id,
    createdAt,
    explanation: "Test explanation",
    proof: {} as FullReport["proof"],
    computed: {
      subject: {
        vin,
        year: 2021,
        make: "Toyota",
        model: "Camry",
        trim: null,
        priceUsd: 18_000,
        miles: 42_000,
        city: "Miami",
        state: "FL",
      },
      mode: "personal",
      verdict: "fair",
      sample: false,
    } as FullReport["computed"],
  };
}

describe("user report history", () => {
  it("stores a report under its browser account and does not mix users", async () => {
    const kv = new MemoryKv();
    const saved = report("report-0001", "4T1KZ1AK4MU060006", "2026-11-05T10:00:00.000Z");
    await kv.set(`report:${saved.id}`, JSON.stringify(saved));
    await rememberUserReport(kv, "user-a", saved.computed.subject.vin, saved.id, saved);

    expect((await listUserReports(kv, "user-a")).map((item) => item.id)).toEqual([saved.id]);
    expect(await listUserReports(kv, "user-b")).toEqual([]);
  });

  it("moves a reopened report to the top without duplicating it", async () => {
    const kv = new MemoryKv();
    const older = report("report-0001", "4T1KZ1AK4MU060006", "2026-11-04T10:00:00.000Z");
    const newer = report("report-0002", "1HGCV1F30MA000001", "2026-11-05T10:00:00.000Z");
    await kv.set(`report:${older.id}`, JSON.stringify(older));
    await kv.set(`report:${newer.id}`, JSON.stringify(newer));
    await rememberUserReport(kv, "user-a", older.computed.subject.vin, older.id, older);
    await rememberUserReport(kv, "user-a", newer.computed.subject.vin, newer.id, newer);
    await rememberUserReport(kv, "user-a", older.computed.subject.vin, older.id, older);

    expect((await listUserReports(kv, "user-a")).map((item) => item.id)).toEqual([newer.id, older.id]);
  });

  it("does not show entries whose report data has expired", async () => {
    const kv = new MemoryKv();
    const saved = report("report-0001", "4T1KZ1AK4MU060006", "2026-11-05T10:00:00.000Z");
    await rememberUserReport(kv, "user-a", saved.computed.subject.vin, saved.id, saved);

    expect(await listUserReports(kv, "user-a")).toEqual([]);
  });
});
