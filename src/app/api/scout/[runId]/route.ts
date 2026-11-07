import { NextResponse } from "next/server";
import { getKv } from "@/io/kv";
import { authorizeScoutRead } from "@/server/scout/access";
import { isScoutEnabled } from "@/server/scout/config";
import { readScoutSignedSession } from "@/server/scout/signed-session";
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

  const access = await authorizeScoutRead(
    kv,
    { bearerToken: bearer(req), signedSession: await readScoutSignedSession() },
    run.ownerId,
  );
  if (!access.ok) {
    return NextResponse.json(access.body, { status: access.status });
  }

  const meta = await loadScoutMeta(kv, runId);
  const isFixture = meta?.isFixture ?? run.inventorySource === "replay";
  const inventoryMode = meta?.inventoryMode ?? (run.inventorySource === "live" ? "live" : "replay");
  const presentation =
    meta?.presentation ??
    (inventoryMode === "live" && !isFixture
      ? { kind: "live_autodev" as const, warning: null }
      : isFixture
        ? {
            kind: "fixture_replay" as const,
            warning:
              "These listings are from a checked-in Auto.dev snapshot for offline proof — not a live market pull.",
          }
        : {
            kind: "live_blocked" as const,
            warning:
              meta?.paidBlockedReason ??
              "Live inventory was requested but not authorized — no fixture was substituted as live.",
          });

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
