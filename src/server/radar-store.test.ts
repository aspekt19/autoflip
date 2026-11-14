import { describe, expect, it } from "vitest";
import { MemoryKv } from "@/io/kv";
import type { SavedSearch } from "@/domain/radar-watch";
import {
  armRadarTestMode,
  claimRadarTestNotification,
  getRadarTestMode,
  listSearches,
  saveSearches,
  stopRadarTestMode,
} from "./radar-store";

const watch: SavedSearch = {
  id: "watch-1",
  ownerId: "owner-1",
  name: "Test watch",
  mode: "personal",
  criteria: { make: "Toyota", model: "RAV4", zip: "80202", priceMax: 25000, radiusMiles: 50 },
  createdAt: "2026-11-14T00:00:00.000Z",
  enabled: true,
  preset: false,
  lastCheckedAt: null,
  pauseReason: null,
};

describe("global Radar test mode", () => {
  it("claims at most one project-wide notification and pauses saved watches", async () => {
    const kv = new MemoryKv();
    await saveSearches(kv, [watch]);
    expect(await claimRadarTestNotification(kv, "alert-1", new Date("2026-11-14T10:00:00Z"))).toBe(true);
    expect(await claimRadarTestNotification(kv, "alert-2", new Date("2026-11-14T10:01:00Z"))).toBe(false);
    expect((await getRadarTestMode(kv)).alertId).toBe("alert-1");
    expect(await listSearches(kv)).toMatchObject([{ enabled: false, pauseReason: "global_test_complete" }]);
  });

  it("re-arms only watches paused by the global one-alert stop", async () => {
    const kv = new MemoryKv();
    await saveSearches(kv, [
      watch,
      { ...watch, id: "manually-paused", enabled: false, pauseReason: null },
    ]);
    await claimRadarTestNotification(kv, "alert-1");
    await armRadarTestMode(kv);
    expect((await getRadarTestMode(kv)).status).toBe("armed");
    expect(await listSearches(kv)).toMatchObject([
      { id: "watch-1", enabled: true, pauseReason: null },
      { id: "manually-paused", enabled: false, pauseReason: null },
    ]);
  });

  it("fails closed when the persisted switch is corrupt", async () => {
    const kv = new MemoryKv();
    await kv.set("radar:test-mode:stopped", "{");
    expect((await getRadarTestMode(kv)).status).toBe("stopped");
    expect(await claimRadarTestNotification(kv, "alert-1")).toBe(false);
  });

  it("supports an admin stop before any alert is sent", async () => {
    const kv = new MemoryKv();
    await saveSearches(kv, [watch]);
    await stopRadarTestMode(kv);
    expect((await getRadarTestMode(kv)).reason).toBe("admin");
    expect(await listSearches(kv)).toMatchObject([{ enabled: false, pauseReason: "global_test_complete" }]);
  });
});
