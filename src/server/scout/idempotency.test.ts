/**
 * Stage1B — durable claim-before-work idempotency.
 * Overlapping same-owner/same-key must share one execution (or explicit in_progress),
 * not dual runIds with Memory last-write vs Kv first-wins divergence.
 */
import { describe, expect, it } from "vitest";
import { MemoryKv } from "@/io/kv";
import {
  canonicalMandateHash,
  claimScoutIdempotency,
  completeScoutIdempotency,
  idemRecordKeyForTest,
} from "./idempotency";
import { executeScoutSafely } from "./safe-execute";
import { clearScoutRunMemory } from "./store";

const baseMandate = {
  mode: "flip" as const,
  preferredMakes: ["Toyota"],
  zip: "72712",
  maxDistanceMiles: 200,
  maxMiles: null,
};

function scoutReq(
  ownerId: string,
  mandate: unknown,
  idempotencyKey: string | null | undefined,
) {
  return {
    ownerId,
    mandate,
    channel: "test" as const,
    planner: "offline_heuristic" as const,
    idempotencyKey,
  };
}

describe("Stage1B claim-lock idempotency", () => {
  it("canonicalMandateHash is stable under key reorder and strips spend claims", () => {
    const a = canonicalMandateHash({
      mode: "flip",
      zip: "72712",
      preferredMakes: ["Toyota"],
      verifiedBalanceUsd: 999,
    });
    const b = canonicalMandateHash({
      preferredMakes: ["Toyota"],
      zip: "72712",
      mode: "flip",
      hardCapUsd: 50,
    });
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it("same mandate + different preferLive/planner intent must not silently share a claim hash", () => {
    const mandate = { mode: "flip", preferredMakes: ["Toyota"], zip: "72712" };
    const base = canonicalMandateHash(mandate, { planner: "offline_heuristic", preferLive: false });
    const live = canonicalMandateHash(mandate, { planner: "offline_heuristic", preferLive: true });
    const serv = canonicalMandateHash(mandate, { planner: "serv", preferLive: false });
    expect(base).not.toBe(live);
    expect(base).not.toBe(serv);
    // Spend fields still must not fork the hash when intent is identical.
    expect(
      canonicalMandateHash(
        { ...mandate, verifiedBalanceUsd: 1 },
        { planner: "offline_heuristic", preferLive: false },
      ),
    ).toBe(base);
  });

  it("overlapping same-owner same-key: only one execution; other in_progress or coherent replay", async () => {
    clearScoutRunMemory();
    const shared = new MemoryKv(); // simulates shared Upstash across "instances"
    const key = "overlap-key-1";
    let gateResolve!: () => void;
    const gate = new Promise<void>((r) => {
      gateResolve = r;
    });
    let entered = 0;

    // Slow first winner: hold claim while second arrives.
    const slow = (async () => {
      const claim = await claimScoutIdempotency({
        kv: shared,
        ownerId: "owner-a",
        clientKey: key,
        mandate: baseMandate,
        env: {}, // non-serverless — MemoryKv allowed for unit proof of SET NX
      });
      expect(claim.kind).toBe("proceed");
      entered += 1;
      gateResolve();
      // Stay in_progress until we complete later.
      await new Promise((r) => setTimeout(r, 40));
      if (claim.kind !== "proceed") return claim;
      await completeScoutIdempotency(shared, claim.recordKey, {
        ownerId: "owner-a",
        mandateHash: claim.mandateHash,
        result: { runId: "winner-run" } as import("@/domain/scout").ScoutRunResult,
        inventoryMode: "replay",
        isFixture: true,
        paidBlockedReason: null,
      });
      return claim;
    })();

    await gate; // first has claimed (no runId yet)
    const second = await claimScoutIdempotency({
      kv: shared,
      ownerId: "owner-a",
      clientKey: key,
      mandate: baseMandate,
      env: {},
    });
    // No runId bound yet — honest in_progress (active overlap), never re-exec / never false-dead.
    expect(second.kind).toBe("in_progress");
    expect(entered).toBe(1);

    await slow;
    const third = await claimScoutIdempotency({
      kv: shared,
      ownerId: "owner-a",
      clientKey: key,
      mandate: baseMandate,
      env: {},
    });
    expect(third.kind).toBe("replay");
    if (third.kind === "replay") {
      expect(third.receipt.result.runId).toBe("winner-run");
    }
  });

  it("executeScoutSafely overlapping handlers share one runId (no dual f021/f920 winners)", async () => {
    clearScoutRunMemory();
    const shared = new MemoryKv();
    const key = "handler-overlap";
    const mandate = { ...baseMandate };

    // Release both after both have started claim path — MemoryKv setNx serializes.
    const a = executeScoutSafely({
      req: scoutReq("owner-a", mandate, key),
      kv: shared,
      env: { SCOUT_ENABLED: "true" },
    });
    const b = executeScoutSafely({
      req: scoutReq("owner-a", mandate, key),
      kv: shared,
      env: { SCOUT_ENABLED: "true" },
    });
    const [ra, rb] = await Promise.all([a, b]);

    const oks = [ra, rb].filter((r) => r.ok);
    const denials = [ra, rb].filter((r) => !r.ok);
    // One completed execution; other may be recovery_needed/in_progress (409) or coherent replay.
    expect(oks.length + denials.length).toBe(2);
    if (oks.length === 2) {
      expect(oks[0]!.ok && oks[1]!.ok).toBe(true);
      if (oks[0]!.ok && oks[1]!.ok) {
        expect(oks[0].result.runId).toBe(oks[1].result.runId);
        expect(oks.some((r) => r.ok && r.idempotentReplay)).toBe(true);
      }
    } else {
      expect(oks).toHaveLength(1);
      expect(denials).toHaveLength(1);
      if (!denials[0]!.ok) {
        expect(denials[0].status).toBe(409);
        expect(["idempotency_in_progress", "idempotency_recovery_needed"]).toContain(
          denials[0].body.error,
        );
      }
      // Retry after winner finished → coherent same runId (replay or reconcile)
      const retry = await executeScoutSafely({
        req: scoutReq("owner-a", mandate, key),
        kv: shared,
        env: { SCOUT_ENABLED: "true" },
      });
      expect(retry.ok).toBe(true);
      if (retry.ok && oks[0]!.ok) {
        expect(retry.result.runId).toBe(oks[0].result.runId);
        expect(retry.idempotentReplay).toBe(true);
      }
    }
  });

  it("MemoryKv and completed receipt agree — no process-local last-write divergence", async () => {
    clearScoutRunMemory();
    const shared = new MemoryKv();
    const key = "kv-coherent";
    const first = await executeScoutSafely({
      req: scoutReq("owner-a", baseMandate, key),
      kv: shared,
      env: { SCOUT_ENABLED: "true" },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Second "instance" — fresh process memory maps, same durable Kv only.
    clearScoutRunMemory();
    const second = await executeScoutSafely({
      req: scoutReq("owner-a", baseMandate, key),
      kv: shared,
      env: { SCOUT_ENABLED: "true" },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.idempotentReplay).toBe(true);
    expect(second.result.runId).toBe(first.result.runId);

    const raw = await shared.get(idemRecordKeyForTest("owner-a", key));
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as { status: string; result: { runId: string } };
    expect(parsed.status).toBe("completed");
    expect(parsed.result.runId).toBe(first.result.runId);
  });

  it("different owners with same Idempotency-Key are isolated", async () => {
    clearScoutRunMemory();
    const shared = new MemoryKv();
    const key = "shared-client-key";
    const a = await executeScoutSafely({
      req: scoutReq("owner-a", baseMandate, key),
      kv: shared,
      env: { SCOUT_ENABLED: "true" },
    });
    const b = await executeScoutSafely({
      req: scoutReq("owner-b", baseMandate, key),
      kv: shared,
      env: { SCOUT_ENABLED: "true" },
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.result.runId).not.toBe(b.result.runId);
    expect(a.idempotentReplay).toBeFalsy();
    expect(b.idempotentReplay).toBeFalsy();
  });

  it("same key + different mandate body → conflict (no second execution)", async () => {
    clearScoutRunMemory();
    const shared = new MemoryKv();
    const key = "body-bind";
    const first = await executeScoutSafely({
      req: scoutReq("owner-a", baseMandate, key),
      kv: shared,
      env: { SCOUT_ENABLED: "true" },
    });
    expect(first.ok).toBe(true);

    const conflict = await executeScoutSafely({
      req: scoutReq(
        "owner-a",
        { ...baseMandate, preferredMakes: ["Honda"] },
        key,
      ),
      kv: shared,
      env: { SCOUT_ENABLED: "true" },
    });
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe("idempotency_conflict");
  });

  it("stuck in_progress after crash must not re-execute expensive work as free", async () => {
    clearScoutRunMemory();
    const shared = new MemoryKv();
    const key = "crash-stuck";
    const claim = await claimScoutIdempotency({
      kv: shared,
      ownerId: "owner-a",
      clientKey: key,
      mandate: baseMandate,
      env: {},
    });
    expect(claim.kind).toBe("proceed");

    // Simulate crash: leave in_progress without runId — honest in_progress, never re-exec / never false-dead.
    const again = await executeScoutSafely({
      req: scoutReq("owner-a", baseMandate, key),
      kv: shared,
      env: { SCOUT_ENABLED: "true" },
    });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("idempotency_in_progress");
  });

  it("missing Idempotency-Key → new run ok, not labeled idempotent", async () => {
    clearScoutRunMemory();
    const shared = new MemoryKv();
    const a = await executeScoutSafely({
      req: scoutReq("owner-a", baseMandate, null),
      kv: shared,
      env: { SCOUT_ENABLED: "true" },
    });
    const b = await executeScoutSafely({
      req: scoutReq("owner-a", baseMandate, undefined),
      kv: shared,
      env: { SCOUT_ENABLED: "true" },
    });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.result.runId).not.toBe(b.result.runId);
    expect(a.idempotentReplay).toBeFalsy();
    expect(b.idempotentReplay).toBeFalsy();
  });

  it("serverless + MemoryKv + Idempotency-Key fails closed (no fake single-process lock)", async () => {
    clearScoutRunMemory();
    const mem = new MemoryKv();
    const result = await executeScoutSafely({
      req: scoutReq("owner-a", baseMandate, "prod-key"),
      kv: mem,
      env: { SCOUT_ENABLED: "true", VERCEL: "1" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(503);
    expect(result.body.error).toBe("idempotency_backend_required");
  });
});
