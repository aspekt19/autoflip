import type { Kv } from "./kv";

type Ledger = {
  balances: Record<string, number>;
  events: Record<string, true>;
  initialized: Record<string, true>;
};

const KEY = "credits:ledger";
/** Shared ledger lock. Per-user locks still allow cross-user lost updates on the single JSON blob. */
const LOCK = "credits:lock";

function empty(): Ledger {
  return { balances: {}, events: {}, initialized: {} };
}

async function read(kv: Kv): Promise<Ledger> {
  const raw = await kv.get(KEY);
  if (!raw) return empty();
  try {
    const parsed = JSON.parse(raw) as Ledger;
    return {
      balances: parsed.balances ?? {},
      events: parsed.events ?? {},
      initialized: parsed.initialized ?? {},
    };
  } catch {
    return empty();
  }
}

async function write(kv: Kv, ledger: Ledger): Promise<void> {
  await kv.set(KEY, JSON.stringify(ledger));
}

async function withLedgerLock<T>(kv: Kv, run: () => Promise<T>): Promise<T | null> {
  let held = false;
  for (let attempt = 0; attempt < 8 && !held; attempt += 1) {
    // Short lock only — TTL is intentional. Never reuse this for durable monthly counters.
    held = await kv.setNx(LOCK, "1", { ttlMs: 4000 });
    if (!held) await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
  }
  if (!held) return null;
  try {
    return await run();
  } finally {
    await kv.delete(LOCK);
  }
}

export async function creditBalance(kv: Kv, userId: string): Promise<number> {
  return (await read(kv)).balances[userId] ?? 0;
}

export async function creditSeen(kv: Kv, userId: string): Promise<boolean> {
  return Boolean((await read(kv)).initialized[userId]);
}

export async function creditEventSeen(kv: Kv, idempotencyKey: string): Promise<boolean> {
  return Boolean((await read(kv)).events[idempotencyKey]);
}

export async function creditGrant(kv: Kv, userId: string, credits: number, idempotencyKey: string): Promise<number> {
  const result = await withLedgerLock(kv, async () => {
    const ledger = await read(kv);
    ledger.initialized[userId] = true;
    if (!ledger.events[idempotencyKey]) {
      ledger.events[idempotencyKey] = true;
      ledger.balances[userId] = (ledger.balances[userId] ?? 0) + credits;
    }
    await write(kv, ledger);
    return ledger.balances[userId] ?? 0;
  });
  return result ?? creditBalance(kv, userId);
}

export async function creditSet(kv: Kv, userId: string, credits: number, idempotencyKey: string): Promise<number> {
  const result = await withLedgerLock(kv, async () => {
    const ledger = await read(kv);
    ledger.initialized[userId] = true;
    if (!ledger.events[idempotencyKey]) {
      ledger.events[idempotencyKey] = true;
      ledger.balances[userId] = credits;
    }
    await write(kv, ledger);
    return ledger.balances[userId] ?? 0;
  });
  return result ?? creditBalance(kv, userId);
}

export async function creditSpend(kv: Kv, userId: string, idempotencyKey: string): Promise<{ ok: boolean; balance: number }> {
  const result = await withLedgerLock(kv, async () => {
    const ledger = await read(kv);
    ledger.initialized[userId] = true;
    if (ledger.events[idempotencyKey]) {
      return { ok: true, balance: ledger.balances[userId] ?? 0 };
    }
    const balance = ledger.balances[userId] ?? 0;
    if (balance < 1) return { ok: false, balance };
    ledger.events[idempotencyKey] = true;
    ledger.balances[userId] = balance - 1;
    await write(kv, ledger);
    return { ok: true, balance: balance - 1 };
  });
  return result ?? { ok: false, balance: await creditBalance(kv, userId) };
}

/**
 * Reverse a prior creditSpend for the same idempotency key so a clean retry can debit again.
 *
 * Why not grant(`refund:${spendKey}`)? That leaves `events[spendKey]` set, so the next
 * creditSpend returns ok without debiting → FREE_REPORT on stable analysis spend keys.
 *
 * Semantics (ledger-locked):
 * - No spend event → no-op (concurrent/repeated compensate is safe).
 * - Spend event present → clear it.
 * - Credit +1 only when a legacy `refund:${spendKey}` grant did not already restore balance.
 */
export async function creditCompensateSpend(
  kv: Kv,
  userId: string,
  spendKey: string,
): Promise<{ ok: boolean; balance: number; compensated: boolean }> {
  const result = await withLedgerLock(kv, async () => {
    const ledger = await read(kv);
    ledger.initialized[userId] = true;
    if (!ledger.events[spendKey]) {
      return { ok: true, balance: ledger.balances[userId] ?? 0, compensated: false };
    }
    delete ledger.events[spendKey];
    const legacyRefundKey = `refund:${spendKey}`;
    if (!ledger.events[legacyRefundKey]) {
      ledger.balances[userId] = (ledger.balances[userId] ?? 0) + 1;
    }
    await write(kv, ledger);
    return { ok: true, balance: ledger.balances[userId] ?? 0, compensated: true };
  });
  return result ?? { ok: false, balance: await creditBalance(kv, userId), compensated: false };
}
