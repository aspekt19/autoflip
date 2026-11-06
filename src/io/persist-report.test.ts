import { describe, expect, it } from "vitest";
import type { FullReport } from "@/domain/types";
import { MemoryKv } from "./kv";
import { listFavoriteReports, listUserReports, rememberUserReport, reportReusable, setFavoriteReport } from "./persist-report";

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


describe("report reuse", () => {
  it("reuses only when mode and typed price/miles still match", () => {
    const saved = report("report-0001", "4T1KZ1AK4MU060006", "2026-11-05T10:00:00.000Z");
    expect(reportReusable(saved, { mode: "personal" })).toBe(true);
    expect(reportReusable(saved, { mode: "flip" })).toBe(false);
    expect(reportReusable(saved, { mode: "personal", askingPriceUsd: 18_000, miles: 42_000 })).toBe(true);
    expect(reportReusable(saved, { mode: "personal", askingPriceUsd: 19_000 })).toBe(false);
    expect(reportReusable(saved, { mode: "personal", miles: 50_000 })).toBe(false);
  });
});

describe("saved cars", () => {
  it("allows a user to favorite only their own saved report", async () => {
    const kv = new MemoryKv();
    const saved = report("report-0003", "1HGCV1F30MA000001", "2026-11-05T11:00:00.000Z");
    await kv.set(`report:${saved.id}`, JSON.stringify(saved));
    await rememberUserReport(kv, "user-a", saved.computed.subject.vin, saved.id, saved);

    const added = await setFavoriteReport(kv, "user-a", saved.id, true);
    expect(added.ok).toBe(true);
    expect(await listFavoriteReports(kv, "user-a")).toHaveLength(1);
    expect(await listFavoriteReports(kv, "user-b")).toEqual([]);
    expect(await setFavoriteReport(kv, "user-b", saved.id, true)).toEqual({ ok: false });
  });

  it("removes a favorite without deleting the report from history", async () => {
    const kv = new MemoryKv();
    const saved = report("report-0004", "2HGFC2F69MH000001", "2026-11-05T12:00:00.000Z");
    await kv.set(`report:${saved.id}`, JSON.stringify(saved));
    await rememberUserReport(kv, "user-a", saved.computed.subject.vin, saved.id, saved);
    await setFavoriteReport(kv, "user-a", saved.id, true);

    const removed = await setFavoriteReport(kv, "user-a", saved.id, false);
    expect(removed.ok).toBe(true);
    expect(await listFavoriteReports(kv, "user-a")).toEqual([]);
    expect((await listUserReports(kv, "user-a")).map((item) => item.id)).toEqual([saved.id]);
  });
});
