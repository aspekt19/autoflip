/**
 * HTTP start handler for Scout — kept OUT of app/api/scout/route.ts so Next
 * route typegen only sees valid Route exports (GET/POST/runtime).
 * Integration tests inject kv/env/harness here; production POST never passes hooks.
 */
import { NextResponse } from "next/server";
import { getKv, type Kv } from "@/io/kv";
import { authorizeScoutStart } from "@/server/scout/access";
import { isScoutEnabled, scoutConfigMessage } from "@/server/scout/config";
import { readPaidExecutionConfig, SCOUT_REQUEST_SAFETY } from "@/server/scout/paid-execution";
import {
  executeScoutRun,
  type ScoutRunHarness,
  type StartScoutBody,
} from "@/server/scout/run";
import { readScoutSignedSession } from "@/server/scout/signed-session";
import { loadScoutRun, saveScoutMeta } from "@/server/scout/store";

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

/**
 * Optional integration-test hooks. Production Next.js `POST` never receives these.
 * Never accepted from request JSON.
 */
export type ScoutPostTestHooks = {
  kv?: Kv;
  env?: Record<string, string | undefined>;
  harness?: ScoutRunHarness | null;
};

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

/** Shared start handler — HTTP entry and integration harness. */
export async function postScoutStart(req: Request, hooks?: ScoutPostTestHooks) {
  const origin = originOf(req);
  const env = hooks?.env ?? process.env;
  const kv = hooks?.kv ?? getKv();
  // Production: signed Scout session OR Bearer af_. Never unsigned af_uid alone.
  const signedSession = hooks ? null : await readScoutSignedSession(env);
  const access = await authorizeScoutStart(
    kv,
    { bearerToken: bearer(req), signedSession },
    origin,
    env,
  );
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

  const idempotencyKey =
    req.headers.get(SCOUT_REQUEST_SAFETY.idempotencyHeader) ??
    req.headers.get("idempotency-key");

  // Env from hooks must reach executeScoutSafely even when harness is omitted
  // (fixture/offline API path). Production POST omits hooks entirely.
  const harness =
    hooks?.harness != null
      ? { ...hooks.harness, env: hooks.harness.env ?? hooks.env }
      : hooks?.env
        ? { env: hooks.env }
        : null;

  const executed = await executeScoutRun({
    ownerId: access.userId,
    apiKeyHash: access.apiKeyHash,
    grantId: access.grantId,
    body,
    kv,
    resume,
    signal: req.signal,
    idempotencyKey,
    // Production POST: harness null → testAuthority null; owner_grant resolved inside.
    harness,
  });

  if (!executed.ok) {
    return NextResponse.json(executed.body, { status: executed.status });
  }

  const { result, inventoryMode, isFixture, paidBlockedReason, idempotentReplay } = executed;
  const status = scoutHttpStatus(result);
  const paid = readPaidExecutionConfig(env);
  // Never label blocked/failed preferLive as live_autodev just because isFixture=false.
  const presentation =
    inventoryMode === "live" && !isFixture
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
              paidBlockedReason ??
              "Live inventory was requested but not authorized — no fixture was substituted as live.",
          };

  // Persist presentation so GET /api/scout/:id does not lose fixture honesty.
  await saveScoutMeta(kv, result.runId, { inventoryMode, isFixture, paidBlockedReason, presentation });

  return NextResponse.json(
    {
      enabled: isScoutEnabled(env),
      note: scoutConfigMessage(true),
      inventoryMode,
      isFixture,
      paidExecutionEnabled: paid.paidExecutionEnabled,
      paidBlockedReason,
      presentation,
      partial: result.partial || result.state === "failed" || result.state === "abstained",
      idempotentReplay: Boolean(idempotentReplay),
      result,
    },
    { status },
  );
}
