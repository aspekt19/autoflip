import { describe, expect, it } from "vitest";
import { MemoryKv } from "@/io/kv";
import {
  acquireRadarTestCycle,
  readRadarTestModeState,
  releaseRadarTestCycle,
  stopRadarAfterFirstTestAlert,
  __radarTestModeKeys,
} from "./radar-test-mode";

describe("Radar one-notification test mode", () => {
  it("allows one cycle and rejects overlapping cycles", async () => {
    const kv = new MemoryKv();
    expect(await acquireRadarTestCycle(kv, "run-1", {})).toEqual({ ok: true });
    const overlap = await acquireRadarTestCycle(kv, "run-2", {});
    expect(overlap.ok).toBe(false);
    if (!overlap.ok) expect(overlap.message).toContain("already running");
    await releaseRadarTestCycle(kv, "run-1");
    expect(await acquireRadarTestCycle(kv, "run-3", {})).toEqual({ ok: true });
  });

  it("stops permanently after the first alert and retains its id", async () => {
    const kv = new MemoryKv();
    await acquireRadarTestCycle(kv, "run-1", {});
    const stopped = await stopRadarAfterFirstTestAlert(kv, "alert-1", "2026-11-14T12:00:00.000Z");
    expect(stopped.stopped).toBe(true);
    expect(stopped.alertId).toBe("alert-1");
    expect(stopped.message).toContain("first test notification");
    await releaseRadarTestCycle(kv, "run-1");

    const next = await acquireRadarTestCycle(kv, "run-2", {});
    expect(next.ok).toBe(false);
    if (!next.ok) {
      expect(next.stopped).toBe(true);
      expect(next.message).toContain("first test notification");
    }
    expect((await readRadarTestModeState(kv)).stopped).toBe(true);
  });

  it("fails closed when the stored safety flag is corrupt", async () => {
    const kv = new MemoryKv();
    await kv.set(__radarTestModeKeys.STOP_KEY, "not-json");
    const state = await readRadarTestModeState(kv);
    expect(state.stopped).toBe(true);
    expect(state.message).toContain("could not be read");
  });

  it("refuses a serverless cycle without distributed storage", async () => {
    const kv = new MemoryKv();
    const result = await acquireRadarTestCycle(kv, "run-1", { VERCEL: "1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("shared persistent storage");
  });
});
