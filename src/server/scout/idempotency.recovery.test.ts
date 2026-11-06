/**
 * Stage1B-recovery — finish-receipt / ambiguous claim without re-executing work.
 * Fault injection: receipt write fail, claim-then-error, restart facade, unfinished no-rerun.
 */
import { describe, expect, it } from "vitest";
import { MemoryKv, type Kv } from "@/io/kv";
import {
  bindScoutIdempotencyRun,
  claimScoutIdempotency,
  completeScoutIdempotency,
  idemRecordKeyForTest,
} from "./idempotency";
import { executeScoutSafely } from "./safe-execute";
import { clearScoutRunMemory, saveScoutRun } from "./store";

const mandate = {
  mode: "flip" as const,
  preferredMakes: ["Toyota"],
  zip: "72712",
  maxDistanceMiles: 200,
};

const intent = { planner: "offline_heuristic", preferLive: false };

describe("Stage1B-recovery", () => {
  it("final receipt write fails after run+bind → later facade reconciles without re-exec", async () => {
    clearScoutRunMemory();
    const durable = new MemoryKv();
    const key = "receipt-fail";
    let failReceipt = false;

    // Fail only when writing status=completed — bind (in_progress+runId) still succeeds.
    const selective = new (class implements Kv {
      readonly backend = "memory" as const;
      get(k: string) {
        return durable.get(k);
      }
      async set(k: string, value: string) {
        if (k === idemRecordKeyForTest("owner-a", key)) {
          const parsed = JSON.parse(value) as { status?: string };
          if (parsed.status === "completed" && failReceipt) {
            throw new Error("injected complete failure");
          }
        }
        return durable.set(k, value);
      }
      setNx(k: string, v: string, o?: { ttlMs?: number }) {
        return durable.setNx(k, v, o);
      }
      delete(k: string) {
        return durable.delete(k);
      }
      incr(k: string) {
        return durable.incr(k);
      }
      decr(k: string) {
        return durable.decr(k);
      }
    })();

    failReceipt = true;
    const first = await executeScoutSafely({
      req: {
        ownerId: "owner-a",
        mandate,
        channel: "test",
        planner: "offline_heuristic",
        idempotencyKey: key,
      },
      kv: selective,
      env: { SCOUT_ENABLED: "true" },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const runId = first.result.runId;

    // Claim still recoverable (in_progress + runId), not completed.
    const raw = await durable.get(idemRecordKeyForTest("owner-a", key));
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!).status).toBe("in_progress");
    expect(JSON.parse(raw!).runId).toBe(runId);

    // Process restart / different facade: clear process memory, same durable Kv.
    clearScoutRunMemory();
    failReceipt = false;
    const second = await executeScoutSafely({
      req: {
        ownerId: "owner-a",
        mandate,
        channel: "test",
        planner: "offline_heuristic",
        idempotencyKey: key,
      },
      kv: selective,
      env: { SCOUT_ENABLED: "true" },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.idempotentReplay).toBe(true);
    expect(second.result.runId).toBe(runId);

    const done = JSON.parse((await durable.get(idemRecordKeyForTest("owner-a", key)))!);
    expect(done.status).toBe("completed");
    expect(done.result.runId).toBe(runId);
  });

  it("claim applied then abandoned (no runId) → in_progress (not false-dead); never re-exec", async () => {
    clearScoutRunMemory();
    const kv = new MemoryKv();
    const key = "claim-then-error";
    const claim = await claimScoutIdempotency({
      kv,
      ownerId: "owner-a",
      clientKey: key,
      mandate,
      intent,
      env: {},
    });
    expect(claim.kind).toBe("proceed");

    // Active overlap / mid-claim — not proven dead. Honest non-terminal in_progress.
    const again = await claimScoutIdempotency({
      kv,
      ownerId: "owner-a",
      clientKey: key,
      mandate,
      intent,
      env: {},
    });
    expect(again.kind).toBe("in_progress");

    const viaHandler = await executeScoutSafely({
      req: {
        ownerId: "owner-a",
        mandate,
        channel: "test",
        planner: "offline_heuristic",
        idempotencyKey: key,
      },
      kv,
      env: { SCOUT_ENABLED: "true" },
    });
    expect(viaHandler.ok).toBe(false);
    if (viaHandler.ok) return;
    expect(viaHandler.body.error).toBe("idempotency_in_progress");
  });

  it("foreign owner cannot reconcile or read another owner's bound run", async () => {
    clearScoutRunMemory();
    const kv = new MemoryKv();
    const key = "owner-iso";
    const first = await executeScoutSafely({
      req: {
        ownerId: "owner-a",
        mandate,
        channel: "test",
        planner: "offline_heuristic",
        idempotencyKey: key,
      },
      kv,
      env: { SCOUT_ENABLED: "true" },
    });
    expect(first.ok).toBe(true);

    // Force stuck in_progress+runId under owner-a, then try owner-b same client key (different record).
    const b = await executeScoutSafely({
      req: {
        ownerId: "owner-b",
        mandate,
        channel: "test",
        planner: "offline_heuristic",
        idempotencyKey: key,
      },
      kv,
      env: { SCOUT_ENABLED: "true" },
    });
    expect(b.ok).toBe(true);
    if (!first.ok || !b.ok) return;
    expect(b.result.runId).not.toBe(first.result.runId);

    // Simulate finish-write gap: completed receipt wiped back to in_progress+runId.
    const aKey = idemRecordKeyForTest("owner-a", key);
    const raw = await kv.get(aKey);
    const completed = JSON.parse(raw!) as {
      ownerId: string;
      mandateHash: string;
      result: { runId: string; ownerId: string };
      inventoryMode: "replay" | "live";
      isFixture: boolean;
      paidBlockedReason: string | null;
    };
    expect(completed.result.ownerId).toBe("owner-a");
    await kv.set(
      aKey,
      JSON.stringify({
        status: "in_progress",
        ownerId: "owner-a",
        mandateHash: completed.mandateHash,
        claimedAt: new Date().toISOString(),
        runId: completed.result.runId,
        inventoryMode: completed.inventoryMode,
        isFixture: completed.isFixture,
        paidBlockedReason: completed.paidBlockedReason,
      }),
    );
    clearScoutRunMemory();
    const reconciled = await claimScoutIdempotency({
      kv,
      ownerId: "owner-a",
      clientKey: key,
      mandate,
      intent,
      env: {},
    });
    expect(reconciled.kind).toBe("replay");
    if (reconciled.kind === "replay") {
      expect(reconciled.receipt.result.ownerId).toBe("owner-a");
      expect(reconciled.receipt.result.runId).toBe(first.result.runId);
    }

    // Different owner same client key uses a different record — no foreign exposure.
    clearScoutRunMemory();
    const foreign = await claimScoutIdempotency({
      kv,
      ownerId: "owner-b",
      clientKey: key,
      mandate,
      intent,
      env: {},
    });
    expect(foreign.kind).toBe("replay");
    if (foreign.kind === "replay") {
      expect(foreign.receipt.result.ownerId).toBe("owner-b");
      expect(foreign.receipt.result.runId).toBe(b.result.runId);
    }
  });

  it("truly unfinished (bound runId but missing durable run) → recovery_needed, no rerun", async () => {
    clearScoutRunMemory();
    const kv = new MemoryKv();
    const key = "missing-run";
    const claim = await claimScoutIdempotency({
      kv,
      ownerId: "owner-a",
      clientKey: key,
      mandate,
      intent,
      env: {},
    });
    expect(claim.kind).toBe("proceed");
    if (claim.kind !== "proceed") return;

    await bindScoutIdempotencyRun(kv, claim.recordKey, {
      ownerId: "owner-a",
      mandateHash: claim.mandateHash,
      runId: "ghost-run-id",
      inventoryMode: "replay",
      isFixture: true,
      paidBlockedReason: null,
    });

    const again = await claimScoutIdempotency({
      kv,
      ownerId: "owner-a",
      clientKey: key,
      mandate,
      intent,
      env: {},
    });
    expect(again.kind).toBe("recovery_needed");
    expect(again.kind === "recovery_needed" && again.reason).toMatch(/no durable run/i);
  });

  it("saveScoutRun Kv failure → no SUCCESS ack; claim stays in_progress; no re-exec / no TTL reclaim", async () => {
    clearScoutRunMemory();
    const durable = new MemoryKv();
    const key = "persist-fail";
    const failing = new (class implements Kv {
      readonly backend = "memory" as const;
      get(k: string) {
        return durable.get(k);
      }
      async set(k: string, value: string) {
        if (k.startsWith("scout:run:")) {
          throw new Error("injected durable run write failure");
        }
        return durable.set(k, value);
      }
      setNx(k: string, v: string, o?: { ttlMs?: number }) {
        return durable.setNx(k, v, o);
      }
      delete(k: string) {
        return durable.delete(k);
      }
      incr(k: string) {
        return durable.incr(k);
      }
      decr(k: string) {
        return durable.decr(k);
      }
    })();

    const first = await executeScoutSafely({
      req: {
        ownerId: "owner-a",
        mandate,
        channel: "test",
        planner: "offline_heuristic",
        idempotencyKey: key,
      },
      kv: failing,
      env: { SCOUT_ENABLED: "true" },
    });
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.status).toBe(503);
    expect(first.body.error).toBe("idempotency_persist_failure");

    // Claim remains in_progress without runId — peer sees active overlap, not false-dead recovery.
    const raw = await durable.get(idemRecordKeyForTest("owner-a", key));
    expect(raw).toBeTruthy();
    const claim = JSON.parse(raw!) as { status: string; runId?: string };
    expect(claim.status).toBe("in_progress");
    expect(claim.runId).toBeUndefined();

    clearScoutRunMemory();
    const peer = await executeScoutSafely({
      req: {
        ownerId: "owner-a",
        mandate,
        channel: "test",
        planner: "offline_heuristic",
        idempotencyKey: key,
      },
      kv: failing,
      env: { SCOUT_ENABLED: "true" },
    });
    expect(peer.ok).toBe(false);
    if (peer.ok) return;
    expect(peer.status).toBe(409);
    expect(peer.body.error).toBe("idempotency_in_progress");
  });

  it("bind then complete success path still replays coherently", async () => {
    clearScoutRunMemory();
    const kv = new MemoryKv();
    const key = "happy-path";
    const first = await executeScoutSafely({
      req: {
        ownerId: "owner-a",
        mandate,
        channel: "test",
        planner: "offline_heuristic",
        idempotencyKey: key,
      },
      kv,
      env: { SCOUT_ENABLED: "true" },
    });
    expect(first.ok).toBe(true);
    clearScoutRunMemory();
    const second = await executeScoutSafely({
      req: {
        ownerId: "owner-a",
        mandate,
        channel: "test",
        planner: "offline_heuristic",
        idempotencyKey: key,
      },
      kv,
      env: { SCOUT_ENABLED: "true" },
    });
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.idempotentReplay).toBe(true);
    expect(second.result.runId).toBe(first.result.runId);
  });

  it("manual bind+failed complete then reconcile via claim API", async () => {
    clearScoutRunMemory();
    const durable = new MemoryKv();
    const key = "manual-reconcile";
    const claim = await claimScoutIdempotency({
      kv: durable,
      ownerId: "owner-a",
      clientKey: key,
      mandate,
      intent,
      env: {},
    });
    expect(claim.kind).toBe("proceed");
    if (claim.kind !== "proceed") return;

    // Produce a real run through execute without idem key, then save+bind under the claim.
    const produced = await executeScoutSafely({
      req: {
        ownerId: "owner-a",
        mandate,
        channel: "test",
        planner: "offline_heuristic",
        idempotencyKey: null,
      },
      kv: durable,
      env: { SCOUT_ENABLED: "true" },
    });
    expect(produced.ok).toBe(true);
    if (!produced.ok) return;
    await saveScoutRun(durable, produced.result);
    await bindScoutIdempotencyRun(durable, claim.recordKey, {
      ownerId: "owner-a",
      mandateHash: claim.mandateHash,
      runId: produced.result.runId,
      inventoryMode: produced.inventoryMode,
      isFixture: produced.isFixture,
      paidBlockedReason: produced.paidBlockedReason,
    });

    // Simulate complete failure — leave in_progress+runId.
    const mid = JSON.parse((await durable.get(claim.recordKey))!);
    expect(mid.status).toBe("in_progress");
    expect(mid.runId).toBe(produced.result.runId);

    clearScoutRunMemory();
    try {
      await completeScoutIdempotency(durable, claim.recordKey, {
        ownerId: "owner-a",
        mandateHash: claim.mandateHash,
        result: produced.result,
        inventoryMode: produced.inventoryMode,
        isFixture: produced.isFixture,
        paidBlockedReason: produced.paidBlockedReason,
      });
    } catch {
      /* ignore */
    }

    // Even without calling complete, reconcile from claim:
    // wipe completed if any, force in_progress+runId again
    await durable.set(
      claim.recordKey,
      JSON.stringify({
        status: "in_progress",
        ownerId: "owner-a",
        mandateHash: claim.mandateHash,
        claimedAt: mid.claimedAt,
        runId: produced.result.runId,
        inventoryMode: produced.inventoryMode,
        isFixture: produced.isFixture,
        paidBlockedReason: produced.paidBlockedReason,
      }),
    );

    clearScoutRunMemory();
    const reconciled = await claimScoutIdempotency({
      kv: durable,
      ownerId: "owner-a",
      clientKey: key,
      mandate,
      intent,
      env: {},
    });
    expect(reconciled.kind).toBe("replay");
    if (reconciled.kind === "replay") {
      expect(reconciled.receipt.result.runId).toBe(produced.result.runId);
    }
  });
});
