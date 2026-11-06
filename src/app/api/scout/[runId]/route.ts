import { NextResponse } from "next/server";
import { getKv } from "@/io/kv";
import { authorizeScoutRead } from "@/server/scout/access";
import { isScoutEnabled } from "@/server/scout/config";
import { loadScoutMeta, loadScoutRun } from "@/server/scout/store";

export const runtime = "nodejs";

function bearer(req: Request): string | null {
  const header = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export async function GET(req: Request, ctx: { params: Promise<{ runId: string }> }) {
  const { runId } = await ctx.params;
  const kv = getKv();
  const run = await loadScoutRun(kv, runId);
  if (!run) {
    return NextResponse.json({ error: "run_not_found" }, { status: 404 });
  }

  const access = await authorizeScoutRead(kv, bearer(req), run.ownerId);
  if (!access.ok) {
    return NextResponse.json(access.body, { status: access.status });
  }

  const meta = await loadScoutMeta(kv, runId);
  const isFixture = meta?.isFixture ?? run.inventorySource === "replay";
  const presentation = meta?.presentation ?? {
    kind: isFixture ? ("fixture_replay" as const) : ("live_autodev" as const),
    warning: isFixture
      ? "These listings are from a checked-in Auto.dev snapshot for offline proof — not a live market pull."
      : null,
  };

  return NextResponse.json({
    enabled: isScoutEnabled(),
    inventoryMode: meta?.inventoryMode ?? run.inventorySource,
    isFixture,
    paidBlockedReason: meta?.paidBlockedReason ?? null,
    presentation,
    partial: run.partial || run.state === "failed" || run.state === "abstained",
    result: run,
  });
}
