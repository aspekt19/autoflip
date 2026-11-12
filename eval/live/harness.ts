/**
 * Live-SERV offline eval harness.
 *
 * Default batch: 8 queries (≈5 Find + 3 Resale), randomized templates, parallel.
 * Never charges report credits.
 *
 * Spend model (documented assumption, not a bill):
 *   each query ≈ 4 SERV calls × $0.03 = $0.12
 *   Cap: stop after EVAL_LIVE_MAX_USD (default 3) OR EVAL_LIVE_MAX_QUERIES (default 8).
 *
 * Default = dry-run (print planned notes, no network).
 * Live needs EVAL_LIVE_ALLOW_PAID=1 + SERV_API_KEY + AUTODEV_API_KEY.
 *
 *   npm run eval:live
 *   EVAL_LIVE_ALLOW_PAID=1 SERV_API_KEY=… AUTODEV_API_KEY=… npm run eval:live
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MemoryKv, getKv } from "@/io/kv";
import { runtimeDeps } from "@/server/deps";
import {
  countByProduct,
  DEFAULT_EVAL_QUERIES,
  generateQueries,
  resolveSeed,
} from "./generate";
import {
  ESTIMATED_USD_PER_QUERY,
  SERV_CALLS_PER_QUERY,
  USD_PER_SERV_CALL,
  liveKeysFromEnv,
  runOneQuery,
} from "./run-one";
import { runOneResaleQuery } from "./run-one-resale";
import type { GeneratedQuery, LiveEvalBatchOptions, LiveEvalCaseResult, LiveEvalReport } from "./types";

const DEFAULT_MAX_QUERIES = DEFAULT_EVAL_QUERIES;
const DEFAULT_MAX_USD = 3;
const HTTP_MAX_QUERIES = DEFAULT_EVAL_QUERIES;
const DEFAULT_CONCURRENCY = 4;

export { HTTP_MAX_QUERIES, DEFAULT_MAX_QUERIES, DEFAULT_MAX_USD, DEFAULT_CONCURRENCY };

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw || !/^\d+(\.\d+)?$/.test(raw)) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function livePaidAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.EVAL_LIVE_ALLOW_PAID === "1";
}

function printCaseLine(result: LiveEvalCaseResult): void {
  const product = result.product ?? "find";
  const pick =
    result.pick?.vin || result.pick?.label
      ? `${result.pick.label ?? "?"} (${result.pick.vin ?? "no-vin"}) verdict=${result.pick.verdict ?? "—"}`
      : "—";
  const relaxed =
    result.relaxedConditions && result.relaxedConditions.length > 0
      ? result.relaxedConditions.map((r) => `${r.name}:${r.why}`).join(" | ")
      : "—";
  const agent = `mode=${result.agentMode ?? "—"} rounds=${result.toolRounds ?? 0} verdictReached=${result.verdictReached ?? false}`;
  const chosen = result.chosenListingCount ?? (result.pick?.vin ? 1 : 0);
  const ask =
    result.pick?.priceUsd != null || result.pick?.miles != null
      ? ` ask=${result.pick.priceUsd ?? "—"} mi=${result.pick.miles ?? "—"}`
      : "";
  if (result.ok) {
    console.log(
      `[ok] ${result.id} [${product}] cars=${result.carsFound} chosen=${chosen} pick=${pick}${ask} ${agent} ${result.elapsedMs}ms`,
    );
  } else {
    const fail = result.failure;
    console.log(
      `[fail] ${result.id} [${product}] step=${fail?.step ?? "?"} error=${fail?.error ?? "?"} chosen=${chosen} ${fail?.message ?? ""}` +
        (fail?.responseId ? ` responseId=${fail.responseId}` : ""),
    );
  }
  console.log(`  relaxed: ${relaxed}`);
  if (result.passReason?.trim()) {
    console.log(`  passReason: ${result.passReason.slice(0, 200)}${result.passReason.length > 200 ? "…" : ""}`);
  }
  console.log(`  note: ${result.note.slice(0, 140)}${result.note.length > 140 ? "…" : ""}`);
}

/** Run async work with a concurrency limit; preserves input order in results. */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = Math.max(1, Math.floor(concurrency));
  const results: R[] = new Array(items.length);
  let next = 0;
  async function runWorker(): Promise<void> {
    while (true) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await worker(items[i]!, i);
    }
  }
  const runners = Array.from({ length: Math.min(limit, items.length) }, () => runWorker());
  await Promise.all(runners);
  return results;
}

export async function runLiveEvalBatch(options: LiveEvalBatchOptions): Promise<LiveEvalReport> {
  const maxQueries = Math.max(1, Math.floor(options.maxQueries));
  const maxUsd = Math.max(0.01, options.maxUsd);
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY));
  const queriesFromNotes: GeneratedQuery[] | null = options.notes?.length
    ? options.notes.map((note, i) => ({
        id: `note_${String(i + 1).padStart(2, "0")}`,
        product: "find" as const,
        note,
        zip: null,
        distanceMiles: null,
        tags: {
          product: "find" as const,
          city: "custom",
          budget: "custom",
          body: "custom",
          need: "custom",
          messy: false,
        },
      }))
    : null;
  const queries = queriesFromNotes ?? generateQueries(options.seed, maxQueries);
  const planned = queries.slice(0, maxQueries);
  const counts = countByProduct(planned);

  if (options.mode === "dry-run") {
    return {
      mode: "dry-run",
      seed: options.seed,
      maxQueries,
      maxUsd,
      estimatedUsd: 0,
      servCallsAssumedPerQuery: SERV_CALLS_PER_QUERY,
      usdPerServCall: USD_PER_SERV_CALL,
      stoppedReason: "dry-run",
      generatedAt: new Date().toISOString(),
      queries: planned,
      results: [],
      findCount: counts.find,
      resaleCount: counts.resale,
    };
  }

  const keys = liveKeysFromEnv();
  const runtime = runtimeDeps();
  const userId = options.userId ?? "live-eval";
  // Shared KV only for Find search-context when HTTP/prod; each Find query also mints its own context.
  const kv = options.userId ? getKv() : new MemoryKv();

  const fixtureRoot = options.recordFixtures
    ? path.join(process.cwd(), "test", "golden", "recordings", "live-eval", String(options.seed))
    : undefined;
  if (fixtureRoot) mkdirSync(fixtureRoot, { recursive: true });

  // Affordability gate before parallel dispatch (8 × $0.12 ≪ $3).
  const affordable = planned.filter((_, i) => (i + 1) * ESTIMATED_USD_PER_QUERY <= maxUsd + 1e-9);
  let stoppedReason: LiveEvalReport["stoppedReason"] =
    affordable.length < planned.length ? "max_usd" : "completed";

  const results = await mapPool(affordable, concurrency, async (query) => {
    // Isolate Find KV per query so parallel mint/update cannot race.
    const queryKv = options.userId ? kv : new MemoryKv();
    const deps = {
      kv: queryKv,
      userId,
      servKey: keys.servKey ?? runtime.servKey,
      autodevKey: keys.autodevKey ?? runtime.autodevKey,
      servModel: runtime.servModel,
      servBaseUrl: runtime.servBaseUrl,
      fixtureRoot,
      caseId: options.recordFixtures ? query.id : undefined,
      secrets: [keys.servKey, keys.autodevKey].filter((v): v is string => Boolean(v)),
    };
    const result =
      query.product === "resale" ? await runOneResaleQuery(query, deps) : await runOneQuery(query, deps);
    printCaseLine(result);
    return result;
  });

  if (results.length >= maxQueries && stoppedReason === "completed") {
    stoppedReason = "max_queries";
  }

  const estimatedUsd = results.reduce((sum, r) => sum + r.estimatedUsd, 0);
  const report: LiveEvalReport = {
    mode: "live",
    seed: options.seed,
    maxQueries,
    maxUsd,
    estimatedUsd,
    servCallsAssumedPerQuery: SERV_CALLS_PER_QUERY,
    usdPerServCall: USD_PER_SERV_CALL,
    stoppedReason,
    generatedAt: new Date().toISOString(),
    queries: planned,
    results,
    findCount: counts.find,
    resaleCount: counts.resale,
  };

  if (options.recordFixtures) {
    const outDir = path.join(process.cwd(), "eval", "results", "live", String(options.seed));
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  }

  return report;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const seed = resolveSeed();
  const maxQueries = Math.floor(envInt("EVAL_LIVE_MAX_QUERIES", DEFAULT_MAX_QUERIES));
  const maxUsd = envInt("EVAL_LIVE_MAX_USD", DEFAULT_MAX_USD);
  const concurrency = Math.floor(envInt("EVAL_LIVE_CONCURRENCY", DEFAULT_CONCURRENCY));
  const wantLive = livePaidAllowed() || argv.includes("--live");

  if (!wantLive) {
    const report = await runLiveEvalBatch({
      seed,
      maxQueries,
      maxUsd,
      mode: "dry-run",
      concurrency,
    });
    console.log(
      `eval:live dry-run seed=${report.seed} queries=${report.queries.length} find=${report.findCount} resale=${report.resaleCount}`,
    );
    console.log(
      `Spend model: ~${SERV_CALLS_PER_QUERY} SERV calls/query × $${USD_PER_SERV_CALL} ≈ $${ESTIMATED_USD_PER_QUERY}/query; caps maxQueries=${maxQueries} maxUsd=$${maxUsd} concurrency=${concurrency}`,
    );
    for (const q of report.queries) {
      console.log(
        `- ${q.id} [${q.product}/${q.tags.city}/${q.tags.body}/${q.tags.budget}/${q.tags.need}${q.tags.messy ? "/messy" : ""}]`,
      );
      console.log(`  ${q.note}`);
    }
    console.log("Dry-run only. Set EVAL_LIVE_ALLOW_PAID=1 with SERV_API_KEY + AUTODEV_API_KEY for live.");
    return 0;
  }

  const keys = liveKeysFromEnv();
  if (!keys.ok) {
    console.error(keys.message);
    return 1;
  }

  console.log(
    `eval:live LIVE seed=${seed} maxQueries=${maxQueries} maxUsd=$${maxUsd} concurrency=${concurrency}`,
  );
  const report = await runLiveEvalBatch({
    seed,
    maxQueries,
    maxUsd,
    mode: "live",
    recordFixtures: true,
    concurrency,
  });
  const okCount = report.results.filter((r) => r.ok).length;
  const chosenCount = report.results.reduce(
    (sum, r) => sum + (r.chosenListingCount ?? (r.pick?.vin ? 1 : 0)),
    0,
  );
  console.log(
    `Done. results=${report.results.length} find=${report.findCount} resale=${report.resaleCount} ok=${okCount} chosenListings=${chosenCount} estimatedUsd=$${report.estimatedUsd.toFixed(2)} stopped=${report.stoppedReason}`,
  );
  console.log(`Report: eval/results/live/${report.seed}/report.json`);
  console.log(`Fixtures: test/golden/recordings/live-eval/${report.seed}/`);
  return report.results.every((r) => r.ok) ? 0 : 1;
}

function invokedDirectly(): boolean {
  const entry = process.argv[1] ?? "";
  return entry.endsWith("harness.ts") || entry.endsWith("harness.js");
}

if (invokedDirectly()) {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
