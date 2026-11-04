import { cookies } from "next/headers";
import { creditStore } from "@/io/store";

const COOKIE = "af_uid";

export async function userId(): Promise<string> {
  const jar = await cookies();
  const existing = jar.get(COOKIE)?.value;
  if (existing && /^[0-9a-f-]{36}$/i.test(existing)) {
    ensureSeed(existing);
    return existing;
  }
  const id = crypto.randomUUID();
  jar.set(COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    secure: process.env.NODE_ENV === "production",
  });
  ensureSeed(id);
  return id;
}

function ensureSeed(id: string) {
  const ledger = creditStore();
  if (ledger.seen(id)) return;
  const raw = process.env.AUTOFLIP_DEV_CREDITS;
  const seed = raw === undefined || raw === "" ? 0 : Number(raw);
  const credits = Number.isInteger(seed) && seed > 0 ? seed : 0;
  ledger.grant(id, credits, `init:${id}`);
}

export function balanceOf(id: string): number {
  return creditStore().balance(id);
}
