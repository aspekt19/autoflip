import type { Kv } from "./kv";

type Ledger = {
  balances: Record<string, number>;
  events: Record<string, true>;
  initialized: Record<string, true>;
};

const KEY = "credits:ledger";

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

export async function creditBalance(kv: Kv, userId: string): Promise<number> {
  return (await read(kv)).balances[userId] ?? 0;
}

export async function creditSeen(kv: Kv, userId: string): Promise<boolean> {
  return Boolean((await read(kv)).initialized[userId]);
}

export async function creditGrant(kv: Kv, userId: string, credits: number, idempotencyKey: string): Promise<number> {
  const ledger = await read(kv);
  ledger.initialized[userId] = true;
  if (!ledger.events[idempotencyKey]) {
    ledger.events[idempotencyKey] = true;
    ledger.balances[userId] = (ledger.balances[userId] ?? 0) + credits;
  }
  await write(kv, ledger);
  return ledger.balances[userId] ?? 0;
}

export async function creditSet(kv: Kv, userId: string, credits: number, idempotencyKey: string): Promise<number> {
  const ledger = await read(kv);
  ledger.initialized[userId] = true;
  if (!ledger.events[idempotencyKey]) {
    ledger.events[idempotencyKey] = true;
    ledger.balances[userId] = credits;
  }
  await write(kv, ledger);
  return ledger.balances[userId] ?? 0;
}

export async function creditSpend(kv: Kv, userId: string, idempotencyKey: string): Promise<{ ok: boolean; balance: number }> {
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
}
