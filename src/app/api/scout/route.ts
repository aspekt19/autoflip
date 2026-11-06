import { NextResponse } from "next/server";
import { getKv } from "@/io/kv";
import { authorizeScoutStart } from "@/server/scout/access";
import { executeScoutRun, type StartScoutBody } from "@/server/scout/run";
import { loadScoutRun } from "@/server/scout/store";
import { isScoutEnabled, scoutConfigMessage } from "@/server/scout/config";

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

  const result = await executeScoutRun({
    ownerId: access.userId,
    body,
    kv,
    resume,
  });

  const status =
    result.state === "failed"
      ? result.failReason === "unauthorized" || result.failReason === "scout_disabled"
        ? 403
        : result.failReason === "mandate_invalid"
          ? 400
          : 200
      : 200;

  return NextResponse.json({
    enabled: isScoutEnabled(),
    note: scoutConfigMessage(true),
    maxProviderCalls: 0,
    result,
  }, { status });
}

export async function GET() {
  return NextResponse.json({
    enabled: isScoutEnabled(),
    message: scoutConfigMessage(isScoutEnabled()),
    endpoints: {
      start: "POST /api/scout",
      read: "GET /api/scout/:runId",
    },
    defaults: {
      maxProviderCalls: 0,
      planner: "offline_heuristic",
      servPlanner: "requires SCOUT_ALLOW_SERV_PLANNER=1 and SERV_API_KEY — not enabled in this slice",
    },
  });
}
