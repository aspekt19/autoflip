/**
 * POST /api/internal/eval-live
 *
 * Auth: Bearer CRON_SECRET or RADAR_CRON_SECRET (same pattern as radar cron).
 * Allowed in production. Runs a small in-process live-eval batch.
 * Never charges report credits (no debitFindDelivery).
 *
 * Body optional: { seed?, maxQueries?, notes? }
 * Default/max 8 queries (≈5 Find + 3 Resale), parallel, no charges.
 */
import { HTTP_MAX_QUERIES, runLiveEvalBatch } from "../../../../../eval/live/harness";
import { resolveSeed } from "../../../../../eval/live/generate";
import { liveKeysFromEnv } from "../../../../../eval/live/run-one";
import { bearer, secretMatch } from "@/server/secrets";

export const dynamic = "force-dynamic";
/** Agentic 8-query batch (5 Find + 3 Resale, concurrency 4) needs headroom beyond a single decide call. */
export const maxDuration = 800;

type Body = {
  seed?: unknown;
  maxQueries?: unknown;
  notes?: unknown;
};

function parseBody(raw: unknown): {
  seed: number;
  maxQueries: number;
  notes: string[] | undefined;
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
  const notes = Array.isArray(body.notes)
    ? body.notes.filter((n): n is string => typeof n === "string" && n.trim().length > 0).map((n) => n.trim())
    : undefined;
  return { seed, maxQueries, notes: notes && notes.length > 0 ? notes.slice(0, maxQueries) : undefined };
}

export async function POST(request: Request) {
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

  const keys = liveKeysFromEnv();
  if (!keys.ok) {
    return Response.json({ error: "missing_keys", message: keys.message }, { status: 503 });
  }

  const parsed = parseBody(await request.json().catch(() => null));
  const maxUsdRaw = Number(process.env.EVAL_LIVE_MAX_USD?.trim() || "1.5");
  const maxUsd = Math.min(3, Number.isFinite(maxUsdRaw) ? maxUsdRaw : 1.5);

  const report = await runLiveEvalBatch({
    seed: parsed.seed,
    maxQueries: parsed.maxQueries,
    maxUsd,
    mode: "live",
    notes: parsed.notes,
    recordFixtures: false,
    userId: "internal-eval-live",
  });

  return Response.json({
    ok: report.results.every((r) => r.ok),
    charged: false,
    ...report,
  });
}
