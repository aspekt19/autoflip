import { describe, expect, it } from "vitest";
import { MemoryKv } from "./kv";
import {
  commitFreeCheck,
  readFreeCheckQuota,
  releaseFreeCheck,
  reserveFreeCheck,
  rollbackFreeCheck,
} from "./free-check-quota";
import { FREE_VEHICLE_CHECKS_PER_MONTH } from "@/domain/free-check-quota";

const USER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

describe("free vehicle-check monthly quota", () => {
  it("reserves up to 3, blocks the 4th, and commits only completed checks", async () => {
    const kv = new MemoryKv();
    const now = new Date("2026-11-09T12:00:00.000Z");

    for (let i = 0; i < FREE_VEHICLE_CHECKS_PER_MONTH; i += 1) {
      const r = await reserveFreeCheck(kv, USER, `k${i}`, now);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect((await commitFreeCheck(kv, USER, `k${i}`, now)).ok).toBe(true);
      }
    }
    const blocked = await reserveFreeCheck(kv, USER, "k3", now);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toBe("exhausted");

    const view = await readFreeCheckQuota(kv, USER, now);
    expect(view.used).toBe(3);
    expect(view.remaining).toBe(0);
    expect(view.resetsAt).toBe("2026-12-01T00:00:00.000Z");
  });

  it("is idempotent on reserve while open, releases failures, and blocks re-free after commit", async () => {
    const kv = new MemoryKv();
    const now = new Date("2026-11-09T12:00:00.000Z");
    const a = await reserveFreeCheck(kv, USER, "same", now);
    const b = await reserveFreeCheck(kv, USER, "same", now);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(b.replay).toBe(true);
    }
    const released = await releaseFreeCheck(kv, USER, "same", now);
    expect(released.released).toBe(true);
    // Slot available again after technical failure release.
    const again = await reserveFreeCheck(kv, USER, "other", now);
    expect(again.ok).toBe(true);

    await commitFreeCheck(kv, USER, "other", now);
    const noUndo = await releaseFreeCheck(kv, USER, "other", now);
    expect(noUndo.released).toBe(false);
    expect((await readFreeCheckQuota(kv, USER, now)).used).toBe(1);

    // Same key after commit → already_completed (fall through to paid; no second free burn).
    const reFree = await reserveFreeCheck(kv, USER, "other", now);
    expect(reFree.ok).toBe(false);
    if (!reFree.ok) expect(reFree.reason).toBe("already_completed");
    expect((await readFreeCheckQuota(kv, USER, now)).used).toBe(1);
  });

  it("reclaims stale reservations and rolls back a committed slot after failed delivery", async () => {
    const kv = new MemoryKv();
    const started = new Date("2026-11-09T12:00:00.000Z");
    const stale = await reserveFreeCheck(kv, USER, "stale-run", started);
    expect(stale.ok).toBe(true);

    const later = new Date(started.getTime() + 7 * 60_000);
    const fresh = await reserveFreeCheck(kv, USER, "fresh-run", later);
    expect(fresh.ok).toBe(true);
    expect((await readFreeCheckQuota(kv, USER, later)).used).toBe(0);

    if (fresh.ok) expect((await commitFreeCheck(kv, USER, "fresh-run", later)).ok).toBe(true);
    expect((await readFreeCheckQuota(kv, USER, later)).used).toBe(1);

    const rolledBack = await rollbackFreeCheck(kv, USER, "fresh-run", later);
    expect(rolledBack.ok).toBe(true);
    expect(rolledBack.rolledBack).toBe(true);
    expect((await readFreeCheckQuota(kv, USER, later)).used).toBe(0);

    // A retry after failed delivery can reserve the same idempotency key again.
    const retry = await reserveFreeCheck(kv, USER, "fresh-run", later);
    expect(retry.ok).toBe(true);
  });

  it("does not allow concurrent reserves to exceed the monthly cap", async () => {
    const kv = new MemoryKv();
    const now = new Date("2026-11-09T12:00:00.000Z");
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => reserveFreeCheck(kv, USER, `c${i}`, now)),
    );
    const ok = results.filter((r) => r.ok);
    expect(ok.length).toBe(FREE_VEHICLE_CHECKS_PER_MONTH);
    expect(results.filter((r) => !r.ok).length).toBe(8 - FREE_VEHICLE_CHECKS_PER_MONTH);
  });

  it("resets on a new UTC month (separate key)", async () => {
    const kv = new MemoryKv();
    const nov = new Date("2026-11-30T23:00:00.000Z");
    for (let i = 0; i < 3; i += 1) {
      await reserveFreeCheck(kv, USER, `n${i}`, nov);
      await commitFreeCheck(kv, USER, `n${i}`, nov);
    }
    expect((await readFreeCheckQuota(kv, USER, nov)).remaining).toBe(0);

    const dec = new Date("2026-12-01T00:00:01.000Z");
    const fresh = await reserveFreeCheck(kv, USER, "d0", dec);
    expect(fresh.ok).toBe(true);
    await commitFreeCheck(kv, USER, "d0", dec);
    expect((await readFreeCheckQuota(kv, USER, dec)).used).toBe(1);
    expect((await readFreeCheckQuota(kv, USER, dec)).remaining).toBe(2);
  });
});
