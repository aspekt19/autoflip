/**
 * POST /api/internal/eval-live
 *
 * Auth: Bearer CRON_SECRET or RADAR_CRON_SECRET (same pattern as radar cron).
 * Allowed in production. Stepped live-eval: one chat turn (or one resumable
 * search step) per request under Hobby 300s — same per-turn shape as
 * /api/find/chat and /api/resale/chat. Never charges report credits.
 *
 * Body:
 *   { action: "start", seed?, maxQueries?, notes? } → create batch, return batchId (no turn yet)
 *   { action: "step", batchId } → one chat hop for the current query
 *   { action: "check", kind: "link"|"vin", listingUrl?, vin? } → Check-by-link / Check-by-VIN
 *     (same auth; never free-check quota / credits; blocked link reported as blocked)
 *   { seed?, maxQueries?, notes? } without action → start + first hop (compat)
 */
import { HTTP_MAX_QUERIES } from "../../../../../eval/live/harness";
import { parseEvalNotes, queriesFromEvalNotes } from "../../../../../eval/live/from-notes";
import { generateQueries, resolveSeed } from "../../../../../eval/live/generate";
import { liveKeysFromEnv } from "../../../../../eval/live/run-one";
import {
  beginEvalActiveChat,
  runEvalChatHop,
} from "../../../../../eval/live/step-chat";
import type { GeneratedQuery } from "../../../../../eval/live/types";
import { getKv } from "@/io/kv";
import { runtimeDeps } from "@/server/deps";
import {
  appendEvalLiveResult,
  createEvalLiveBatch,
  evalLiveBatchToReport,
  readEvalLiveBatch,
  storeEvalLiveBatch,
  withEvalLiveActive,
} from "@/server/eval-live-batch";
import { runEvalLiveCheck } from "@/server/eval-live-check";
import { bearer, secretMatch } from "@/server/secrets";

export const dynamic = "force-dynamic";
/** One chat hop per request — must stay within Vercel Hobby maxDuration 300. */
export const maxDuration = 300;

type Body = {
  action?: unknown;
  batchId?: unknown;
  seed?: unknown;
  maxQueries?: unknown;
  notes?: unknown;
  kind?: unknown;
  listingUrl?: unknown;
  vin?: unknown;
  optionalZip?: unknown;
};

function parseStart(raw: unknown): {
  seed: number;
  maxQueries: number;
  notes: ReturnType<typeof parseEvalNotes>;
} {
  const body = raw && typeof raw === "object" ? (raw as Body) : {};
  const seed =
    typeof body.seed === "number" && Number.isFinite(body.seed)
      ? Math.floor(body.seed)
      : typeof body.seed === "string" && /^\d+$/.test(body.seed.trim())
        ? Number(body.seed.trim())
        : resolveSeed();
  const requested =
    typeof body.maxQueries === "number" && Number.isFinite(body.maxQueries)
      ? Math.floor(body.maxQueries)
      : typeof body.maxQueries === "string" && /^\d+$/.test(body.maxQueries.trim())
        ? Number(body.maxQueries.trim())
        : HTTP_MAX_QUERIES;
  const maxQueries = Math.max(1, Math.min(HTTP_MAX_QUERIES, requested));
  const notes = parseEvalNotes(body.notes);
  return {
    seed,
    maxQueries,
    notes: notes && notes.length > 0 ? notes.slice(0, maxQueries) : undefined,
  };
}

async function authorize(request: Request): Promise<Response | null> {
  const radar = process.env.RADAR_CRON_SECRET?.trim() ?? "";
  const vercel = process.env.CRON_SECRET?.trim() ?? "";
  if (!radar && !vercel) {
    return Response.json(
      {
        error: "not_configured",
        message: "RADAR_CRON_SECRET (or CRON_SECRET) is not set.",
      },
      { status: 503 },
    );
  }
  const token = bearer(request);
  const authed = (radar && secretMatch(token, radar)) || (vercel && secretMatch(token, vercel));
  if (!authed) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

export async function POST(request: Request) {
  const denied = await authorize(request);
  if (denied) return denied;

  const keys = liveKeysFromEnv();
  if (!keys.ok) {
    return Response.json({ error: "missing_keys", message: keys.message }, { status: 503 });
  }

  const raw = (await request.json().catch(() => null)) as Body | null;
  const actionRaw = typeof raw?.action === "string" ? raw.action.trim().toLowerCase() : "";
  const action =
    actionRaw === "start" || actionRaw === "step" || actionRaw === "check"
      ? actionRaw
      : typeof raw?.batchId === "string" && raw.batchId.trim()
        ? "step"
        : "start_and_step";

  const kv = getKv();
  const maxUsdRaw = Number(process.env.EVAL_LIVE_MAX_USD?.trim() || "1.5");
  const maxUsd = Math.min(3, Number.isFinite(maxUsdRaw) ? maxUsdRaw : 1.5);
  const runtime = runtimeDeps();
  const userId = "internal-eval-live";

  if (action === "check") {
    const kindRaw = typeof raw?.kind === "string" ? raw.kind.trim().toLowerCase() : "";
    const kind = kindRaw === "link" || kindRaw === "vin" ? kindRaw : null;
    if (!kind) {
      return Response.json(
        { error: "invalid_body", message: 'action=check requires kind "link" or "vin".' },
        { status: 400 },
      );
    }
    const result = await runEvalLiveCheck({
      kind,
      listingUrl: typeof raw?.listingUrl === "string" ? raw.listingUrl : null,
      vin: typeof raw?.vin === "string" ? raw.vin : null,
      optionalZip: typeof raw?.optionalZip === "string" ? raw.optionalZip : null,
    });
    return Response.json({
      ...result,
      charged: false,
      done: true,
      check: result,
    });
  }

  async function runNextHop(batchId: string) {
    const batch = await readEvalLiveBatch(kv, batchId);
    if (!batch || batch.exp < Math.floor(Date.now() / 1000)) {
      return Response.json(
        { error: "batch_not_found", message: "Eval batch expired or was not found." },
        { status: 404 },
      );
    }
    if (batch.status === "completed" || batch.nextIndex >= batch.queries.length) {
      const report = evalLiveBatchToReport(batch);
      return Response.json({
        ok: report.results.every((r) => r.ok),
        charged: false,
        done: true,
        batchId: batch.batchId,
        nextIndex: batch.nextIndex,
        active: null,
        ...report,
      });
    }

    const query = batch.queries[batch.nextIndex]!;
    const active = batch.active ?? beginEvalActiveChat(batch.nextIndex);
    const deps = {
      kv,
      userId,
      servKey: keys.servKey ?? runtime.servKey!,
      autodevKey: keys.autodevKey ?? runtime.autodevKey!,
      servModel: runtime.servModel,
      servBaseUrl: runtime.servBaseUrl,
    };

    const hop = await runEvalChatHop({ query, active, deps });

    if (hop.kind === "in_progress") {
      const next = withEvalLiveActive(batch, hop.active);
      await storeEvalLiveBatch(kv, next);
      const report = evalLiveBatchToReport(next);
      return Response.json({
        ok: true,
        charged: false,
        done: false,
        batchId: next.batchId,
        nextIndex: next.nextIndex,
        queryId: query.id,
        product: query.product,
        hopStatus: hop.turnStatus,
        sessionId: hop.active.sessionId,
        hops: hop.active.hops,
        asked: hop.active.asked,
        briefConfirmed: hop.active.briefConfirmed,
        active: hop.active,
        lastHop: {
          status: hop.turnStatus,
          ok: hop.turnOk,
          httpStatus: hop.httpStatus,
        },
        ...report,
      });
    }

    const next = appendEvalLiveResult(batch, hop.result);
    await storeEvalLiveBatch(kv, next);
    const report = evalLiveBatchToReport(next);
    return Response.json({
      ok: report.results.every((r) => r.ok),
      charged: false,
      done: next.status === "completed",
      batchId: next.batchId,
      nextIndex: next.nextIndex,
      queryId: query.id,
      product: query.product,
      hopStatus: hop.turnStatus,
      sessionId:
        typeof hop.body.sessionId === "string" ? hop.body.sessionId : active.sessionId,
      hops: hop.hops,
      asked: hop.asked,
      briefConfirmed: hop.briefConfirmed,
      active: null,
      lastResult: hop.result,
      lastHop: {
        status: hop.turnStatus,
        ok: hop.turnOk,
        httpStatus: hop.httpStatus,
      },
      ...report,
    });
  }

  if (action === "step") {
    const batchId = typeof raw?.batchId === "string" ? raw.batchId.trim() : "";
    if (!batchId) {
      return Response.json(
        { error: "invalid_body", message: "batchId is required for action=step." },
        { status: 400 },
      );
    }
    return runNextHop(batchId);
  }

  const parsed = parseStart(raw);
  const queries = parsed.notes
    ? queriesFromEvalNotes(parsed.notes, parsed.maxQueries)
    : generateQueries(parsed.seed, parsed.maxQueries);
  const batch = createEvalLiveBatch({
    seed: parsed.seed,
    maxQueries: parsed.maxQueries,
    maxUsd,
    queries,
  });
  await storeEvalLiveBatch(kv, batch);

  if (action === "start") {
    const report = evalLiveBatchToReport(batch);
    return Response.json({
      ok: true,
      charged: false,
      done: false,
      batchId: batch.batchId,
      nextIndex: 0,
      active: null,
      ...report,
    });
  }

  // Compat: start and immediately run the first chat hop (not a full query).
  return runNextHop(batch.batchId);
}
