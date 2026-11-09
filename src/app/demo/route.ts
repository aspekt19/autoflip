import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { resolveProductFlags } from "@/domain/product-flags";
import { DEMO_USER_ID } from "@/domain/radar-watch";
import { getKv } from "@/io/kv";
import { ensureDemoAccount } from "@/server/radar-store";
import { cookieOptions } from "@/server/session";
import { secretMatch } from "@/server/secrets";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const key = new URL(request.url).searchParams.get("key") ?? "";
  const expected = process.env.DEMO_ACCESS_KEY?.trim() ?? "";
  if (!secretMatch(key, expected)) {
    return new Response("This preview link is not valid.", { status: 401, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  const jar = await cookies();
  jar.set("af_uid", DEMO_USER_ID, cookieOptions());
  await ensureDemoAccount(getKv(), new Date());
  const flags = resolveProductFlags();
  const dest = flags.dealRadar ? "/radar" : flags.resaleEvaluate ? "/resale" : "/";
  return NextResponse.redirect(new URL(dest, request.url));
}
