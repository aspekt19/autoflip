/**
 * Live-SERV offline eval harness.
 *
 * Spend model (documented assumption, not a bill):
 *   each query ≈ find_plan + find_triage + find_decide + find_challenge = 4 SERV calls
 *   ESTIMATED_USD_PER_QUERY = 4 * $0.03 = $0.12
 *   Cap: stop after EVAL_LIVE_MAX_USD (default 3) OR EVAL_LIVE_MAX_QUERIES (default 24).
 *   4 * 24 = 96 calls ≈ $2.88 under the $3 hard cap.
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
import { generateQueries, resolveSeed } from "./generate";
import {
  ESTIMATED_USD_PER_QUERY,
  SERV_CALLS_PER_QUERY,
  USD_PER_SERV_CALL,
  liveKeysFromEnv,
  runOneQuery,
} from "./run-one";
import type { GeneratedQuery, LiveEvalBatchOptions, LiveEvalReport } from "./types";

const DEFAULT_MAX_QUERIES = 24;
const DEFAULT_MAX_USD = 3;
const HTTP_MAX_QUERIES = 8;

export { HTTP_MAX_QUERIES, DEFAULT_MAX_QUERIES, DEFAULT_MAX_USD };

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw || !/^\d+(\.\d+)?$/.test(raw)) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function livePaidAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.EVAL_LIVE_ALLOW_PAID === "1";
}

function printCaseLine(result: LiveEvalReport["results"][number]): void {
  const hardKeys = result.searchSpec ? Object.keys(result.searchSpec.hard).join(",") || "—" : "—";
  const softKeys = result.searchSpec ? Object.keys(result.searchSpec.soft).join(",") || "—" : "—";
  const pick =
    result.pick?.vin || result.pick?.label
      ? `${result.pick.label ?? "?"} (${result.pick.vin ?? "no-vin"}) verdict=${result.pick.verdict ?? "—"}`
      : "—";
  if (result.ok) {
    console.log(
      `[ok] ${result.id} cars=${result.carsFound} hard={${hardKeys}} soft={${softKeys}} pick=${pick} ${result.elapsedMs}ms`,
    );
  } else {
    const fail = result.failure;
    console.log(
      `[fail] ${result.id} step=${fail?.step ?? "?"} error=${fail?.error ?? "?"} ${fail?.message ?? ""}` +
        (fail?.responseId ? ` responseId=${fail.responseId}` : ""),
    );
  }
  console.log(`  note: ${result.note.slice(0, 140)}${result.note.length > 140 ? "…" : ""}`);
}

export async function runLiveEvalBatch(options: LiveEvalBatchOptions): Promise<LiveEvalReport> {
  const maxQueries = Math.max(1, Math.floor(options.maxQueries));
  const maxUsd = Math.max(0.01, options.maxUsd);
  const queriesFromNotes: GeneratedQuery[] | null = options.notes?.length
    ? options.notes.map((note, i) => ({
        id: `note_${String(i + 1).padStart(2, "0")}`,
        note,
        zip: null,
        distanceMiles: null,
        tags: { city: "custom", budget: "custom", body: "custom", need: "custom", messy: false },
      }))
    : null;
  const queries = queriesFromNotes ?? generateQueries(options.seed, maxQueries);
  const planned = queries.slice(0, maxQueries);

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
    };
  }

  const keys = liveKeysFromEnv();
  const runtime = runtimeDeps();
  const userId = options.userId ?? "live-eval";
  // HTTP/prod passes useSharedKv; CLI uses MemoryKv (not serverless).
  const kv = options.userId ? getKv() : new MemoryKv();

  const fixtureRoot = options.recordFixtures
    ? path.join(process.cwd(), "test", "golden", "recordings", "live-eval", String(options.seed))
    : undefined;
  if (fixtureRoot) mkdirSync(fixtureRoot, { recursive: true });

  const results: LiveEvalReport["results"] = [];
  let estimatedUsd = 0;
  let stoppedReason: LiveEvalReport["stoppedReason"] = "completed";

  for (const query of planned) {
    if (estimatedUsd + ESTIMATED_USD_PER_QUERY > maxUsd + 1e-9) {
      stoppedReason = "max_usd";
      break;
    }
    if (results.length >= maxQueries) {
      stoppedReason = "max_queries";
      break;
    }

    const result = await runOneQuery(query, {
      kv,
      userId,
      servKey: keys.servKey ?? runtime.servKey,
      autodevKey: keys.autodevKey ?? runtime.autodevKey,
      servModel: runtime.servModel,
      servBaseUrl: runtime.servBaseUrl,
      fixtureRoot,
      caseId: options.recordFixtures ? query.id : undefined,
      secrets: [keys.servKey, keys.autodevKey].filter((v): v is string => Boolean(v)),
    });
    results.push(result);
    estimatedUsd += result.estimatedUsd;
    printCaseLine(result);
  }

  if (results.length >= maxQueries && stoppedReason === "completed") {
    stoppedReason = "max_queries";
  }

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
  const wantLive = livePaidAllowed() || argv.includes("--live");

  if (!wantLive) {
    const report = await runLiveEvalBatch({
      seed,
      maxQueries,
      maxUsd,
      mode: "dry-run",
    });
    console.log(`eval:live dry-run seed=${report.seed} queries=${report.queries.length}`);
    console.log(
      `Spend model: ~${SERV_CALLS_PER_QUERY} SERV calls/query × $${USD_PER_SERV_CALL} ≈ $${ESTIMATED_USD_PER_QUERY}/query; caps maxQueries=${maxQueries} maxUsd=$${maxUsd}`,
    );
    for (const q of report.queries) {
      console.log(`- ${q.id} [${q.tags.city}/${q.tags.body}/${q.tags.budget}/${q.tags.need}${q.tags.messy ? "/messy" : ""}]`);
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

  console.log(`eval:live LIVE seed=${seed} maxQueries=${maxQueries} maxUsd=$${maxUsd}`);
  const report = await runLiveEvalBatch({
    seed,
    maxQueries,
    maxUsd,
    mode: "live",
    recordFixtures: true,
  });
  console.log(
    `Done. results=${report.results.length} ok=${report.results.filter((r) => r.ok).length} estimatedUsd=$${report.estimatedUsd.toFixed(2)} stopped=${report.stoppedReason}`,
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
