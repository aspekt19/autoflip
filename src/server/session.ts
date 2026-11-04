import { cookies } from "next/headers";
import { creditBalance, creditGrant, creditSeen, creditSpend } from "@/io/credit-book";
import { getKv } from "@/io/kv";
import { DEMO_USER_ID } from "@/domain/radar-watch";
import { ensureDemoAccount } from "./radar-store";

const COOKIE = "af_uid";
const ID_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|demo-shared)$/i;

export async function userId(): Promise<string> {
  const jar = await cookies();
  const existing = jar.get(COOKIE)?.value;
  if (existing && ID_RE.test(existing)) {
    await ensureAccount(existing);
    return existing;
  }
  const id = crypto.randomUUID();
  jar.set(COOKIE, id, cookieOptions());
  await ensureAccount(id);
  return id;
}

export function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    secure: process.env.NODE_ENV === "production",
  };
}

async function ensureAccount(id: string) {
  const kv = getKv();
  if (id === DEMO_USER_ID) {
    await ensureDemoAccount(kv, new Date());
    return;
  }
  if (await creditSeen(kv, id)) return;
  const raw = process.env.AUTOFLIP_DEV_CREDITS;
  const seed = raw === undefined || raw === "" ? 0 : Number(raw);
  const credits = Number.isInteger(seed) && seed > 0 ? seed : 0;
  await creditGrant(kv, id, credits, `init:${id}`);
}

export async function balanceOf(id: string): Promise<number> {
  return creditBalance(getKv(), id);
}

export async function spendCredit(id: string, idempotencyKey: string) {
  return creditSpend(getKv(), id, idempotencyKey);
}

export async function grantCredit(id: string, credits: number, idempotencyKey: string) {
  return creditGrant(getKv(), id, credits, idempotencyKey);
}

export function isDemoUser(id: string): boolean {
  return id === DEMO_USER_ID;
}
