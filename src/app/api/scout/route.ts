import { NextResponse } from "next/server";
import { getKv } from "@/io/kv";
import { authorizeScoutStart } from "@/server/scout/access";
import { isScoutEnabled, scoutConfigMessage } from "@/server/scout/config";
import { readPaidExecutionConfig } from "@/server/scout/paid-execution";
import { executeScoutRun, type StartScoutBody } from "@/server/scout/run";
import { loadScoutRun, saveScoutMeta } from "@/server/scout/store";

export const runtime = "nodejs";

function bearer(req: Request): string | null {
  const header = req.headers.get("authorization") ?? req.headers.get("Authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function originOf(req: Request): string {
  try {
    return new URL(req.url).origin;
  } catch {
    return "http://localhost:3000";
  }
}

/** POST /api/scout — start or resume a bounded scout run. Default disabled. */
export async function POST(req: Request) {
  const origin = originOf(req);
  const kv = getKv();
  const access = await authorizeScoutStart(kv, bearer(req), origin);
  if (!access.ok) {
    return NextResponse.json(access.body, { status: access.status });
  }

  let body: StartScoutBody;
  try {
    body = (await req.json()) as StartScoutBody;
  } catch {
    return NextResponse.json({ error: "invalid_json", message: "Body must be JSON." }, { status: 400 });
  }

  if (!body?.mandate) {
    return NextResponse.json({ error: "mandate_required", message: "mandate is required." }, { status: 400 });
  }

  let resume = null;
  if (body.resumeRunId) {
    resume = await loadScoutRun(kv, body.resumeRunId);
    if (!resume) {
      return NextResponse.json({ error: "run_not_found", message: "resumeRunId not found." }, { status: 404 });
    }
    if (resume.ownerId !== access.userId) {
      return NextResponse.json({ error: "unauthorized", message: "Cannot resume another owner's run." }, { status: 403 });
    }
  }

  const executed = await executeScoutRun({
    ownerId: access.userId,
    body,
    kv,
    resume,
  });

  if (!executed.ok) {
    return NextResponse.json(executed.body, { status: executed.status });
  }

  const { result, inventoryMode, isFixture, paidBlockedReason } = executed;
  const status = scoutHttpStatus(result);
  const paid = readPaidExecutionConfig();
  const presentation = isFixture
    ? {
        kind: "fixture_replay" as const,
        warning:
          "These listings are from a checked-in Auto.dev snapshot for offline proof — not a live market pull.",
      }
    : { kind: "live_autodev" as const, warning: null };

  // Persist presentation so GET /api/scout/:id does not lose fixture honesty.
  await saveScoutMeta(kv, result.runId, { inventoryMode, isFixture, paidBlockedReason, presentation });

  return NextResponse.json(
    {
      enabled: isScoutEnabled(),
      note: scoutConfigMessage(true),
      inventoryMode,
      isFixture,
      paidExecutionEnabled: paid.paidExecutionEnabled,
      paidBlockedReason,
      presentation,
      partial: result.partial || result.state === "failed" || result.state === "abstained",
      result,
    },
    { status },
  );
}

function scoutHttpStatus(result: import("@/domain/scout").ScoutRunResult): number {
  if (result.state === "completed") return 200;
  if (result.state === "abstained") return 200;
  if (result.failReason === "unauthorized" || result.failReason === "scout_disabled") return 403;
  if (result.failReason === "mandate_invalid") return 400;
  if (
    result.failReason === "serv_timeout" ||
    result.failReason === "serv_refused" ||
    result.failReason === "serv_unavailable" ||
    result.failReason === "provider_unavailable" ||
    result.failReason === "budget_exhausted" ||
    result.failReason === "inventory_unconfigured"
  ) {
    return 503;
  }
  if (result.state === "failed") return 422;
  return 200;
}

export async function GET() {
  const paid = readPaidExecutionConfig();
  return NextResponse.json({
    enabled: isScoutEnabled(),
    message: scoutConfigMessage(isScoutEnabled()),
    paidExecutionEnabled: paid.paidExecutionEnabled,
    endpoints: {
      start: "POST /api/scout",
      read: "GET /api/scout/:runId",
    },
    defaults: {
      inventory:
        "replay fixture unless SCOUT_PAID_EXECUTION + AUTODEV_API_KEY + SCOUT_MAX_PROVIDER_CALLS_HARD_CEILING + verified reserve envs + Upstash",
      planner: "offline_heuristic (scout_plan SERV only when SCOUT_ALLOW_SERV_PLANNER + paid path)",
      clientSpendAttestation: "rejected — server verified reserve + quota only",
    },
  });
}
