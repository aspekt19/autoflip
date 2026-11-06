import type { Kv } from "./kv";
import { creditBalance, creditEventSeen, creditGrant, creditSpend } from "./credit-book";

/**
 * Move an entire anonymous balance onto an authenticated account under one
 * idempotency key family. Never invents credits; never zeros the destination.
 * Source balance is drained only after destination grant succeeds for each unit
 * via grant+spend pairing keyed per transfer.
 */
export async function transferCredits(
  kv: Kv,
  fromUserId: string,
  toUserId: string,
  transferId: string,
): Promise<{ ok: boolean; moved: number; fromBalance: number; toBalance: number }> {
  if (fromUserId === toUserId) {
    const bal = await creditBalance(kv, toUserId);
    return { ok: true, moved: 0, fromBalance: bal, toBalance: bal };
  }
  const doneKey = `xfer-done:${transferId}`;
  if (await creditEventSeen(kv, doneKey)) {
    return {
      ok: true,
      moved: 0,
      fromBalance: await creditBalance(kv, fromUserId),
      toBalance: await creditBalance(kv, toUserId),
    };
  }

  const fromBalance = await creditBalance(kv, fromUserId);
  if (fromBalance < 1) {
    await creditGrant(kv, toUserId, 0, doneKey);
    return { ok: true, moved: 0, fromBalance, toBalance: await creditBalance(kv, toUserId) };
  }

  // Grant the full amount to destination first (idempotent), then drain source.
  await creditGrant(kv, toUserId, fromBalance, `xfer-grant:${transferId}`);
  for (let i = 0; i < fromBalance; i += 1) {
    const spent = await creditSpend(kv, fromUserId, `xfer-drain:${transferId}:${i}`);
    if (!spent.ok) {
      return {
        ok: false,
        moved: i,
        fromBalance: spent.balance,
        toBalance: await creditBalance(kv, toUserId),
      };
    }
  }
  await creditGrant(kv, toUserId, 0, doneKey);
  return {
    ok: true,
    moved: fromBalance,
    fromBalance: await creditBalance(kv, fromUserId),
    toBalance: await creditBalance(kv, toUserId),
  };
}
