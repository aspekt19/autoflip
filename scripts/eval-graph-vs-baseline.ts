/**
 * Find decide: SERV graph (one run: decide → challenge → keep/revise) vs the
 * current two-call path (find_decide + find_challenge), on the same frozen cases.
 *
 * Frozen inputs: eval/comparison/fixtures/find-cases.json (captured listings + comps).
 * Code builds the same fact sheet for both arms (selectBestDealOnEvidence, no network
 * public-record checks), so only the decision path differs.
 *
 * Arms:
 *   - two_call          — runFindDecideServ with graphId null (find_decide + find_challenge)
 *   - graph             — runFindDecideServ with the graph (one run)
 *   - loop_second_check — previous prod path: runFindGraphSecondCheck after the agentic Find loop.
 *                         The loop's pick is a frozen stand-in (code's top-ranked car, "negotiate", high).
 *                         Published pick stays the loop's; the graph is a second check.
 *   - graph_primary     — new prod path: runFindGraphDecide. The graph publishes the pick/action/
 *                         confidence; the loop stand-in is fallback if the graph cannot run.
 *
 * Reports per arm:
 *   - validator pass rate   — the arm's own answer passed validateFindDecide/validateFindChallenge
 *                             (graph arm: no fallback to the two-call path)
 *   - decision agreement    — modal pick + action equal between arms, per case
 *   - repeat consistency    — share of repeats equal to the arm's modal pick + action
 *   - latency               — p50 / p95 wall-clock per decision
 *   - cost                  — SERV HTTP calls and the token / cost fields the provider returned
 *                             (null when the provider did not return them; never estimated)
 *
 * Default is a dry run: builds every fact sheet, makes no HTTP call, spends nothing.
 *
 * Live (spends SERV credits):
 *   EVAL_GRAPH_ALLOW_PAID=1 SERV_API_KEY=… SERV_GRAPH_FIND_DECIDE_ID=gr_… \
 *     npx tsx scripts/eval-graph-vs-baseline.ts --live --repeats 3 --cases 5
 *
 * Flags: --arms two_call,graph,loop_second_check,graph_primary (default all), --live, --repeats N (default 3), --cases N (default all), --shortlist N (default 5),
 *        --out PATH (default eval/results/graph-vs-baseline.json)
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { selectBestDealOnEvidence } from "@/domain/find-best-deal";
import { explicitNeedFromText, type StructuredNeed } from "@/domain/need";
import { runFindDecideServ, type FindDecideServResult } from "@/server/find-decide-serv";
import { runFindGraphDecide, type FindGraphDecideResult } from "@/server/find-graph-decide";
import { findDecideGraphId } from "@/server/serv/graph";
import { mapFindAgentLoopToDecide } from "@/server/find-agent/map-to-decide";
import {
  FIND_GRAPH_CHECK_MAX_MS,
  FIND_GRAPH_CHECK_SAFETY_MS,
  runFindGraphSecondCheck,
  type FindGraphSecondCheckResult,
} from "@/server/find-graph-second-check";
import type { Listing } from "@/domain/types";
import { toListing } from "../eval/comparison/arms";
import type { FindCaseFixture } from "../eval/comparison/types";

const ROOT = resolve(__dirname, "..");
const FIXTURE = resolve(ROOT, "eval/comparison/fixtures/find-cases.json");

const ARMS = ["two_call", "graph", "loop_second_check", "graph_primary"] as const;
type Arm = (typeof ARMS)[number];

type Attempt = {
  arm: Arm;
  repeat: number;
  ok: boolean;
  usedGraph: boolean;
  pickKey: string | null;
  action: string | null;
  confidence: string | null;
  secondPass: string;
  latencyMs: number;
  httpCalls: number;
  tokens: number | null;
  costUsd: number | null;
  runIds: string[];
  failure: string | null;
  decidedBy?: "graph" | "fallback" | "two_call" | null;
  publishedPickKey?: string | null;
  publishedAction?: string | null;
};

type CaseRow = {
  caseId: string;
  synthetic: boolean;
  shortlistKeys: string[];
  plannedCalls?: Record<Arm, number>;
  loopPick?: string | null;
  modal: Record<Arm, string | null>;
  agree: boolean | null;
  attempts: Attempt[];
};

type Args = { arms: Arm[]; live: boolean; repeats: number; cases: number | null; shortlist: number; out: string };

function parseArgs(argv: string[]): Args {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const arms = (get("--arms") ?? ARMS.join(","))
    .split(",")
    .map((v) => v.trim())
    .filter((v): v is Arm => (ARMS as readonly string[]).includes(v));
  return {
    arms: arms.length ? arms : [...ARMS],
    live: argv.includes("--live"),
    repeats: Math.max(1, Number(get("--repeats") ?? 3)),
    cases: get("--cases") ? Math.max(1, Number(get("--cases"))) : null,
    shortlist: Math.max(2, Number(get("--shortlist") ?? 5)),
    out: resolve(ROOT, get("--out") ?? "eval/results/graph-vs-baseline.json"),
  };
}

function buildCase(fixture: FindCaseFixture, shortlistSize: number) {
  const parsed = explicitNeedFromText(fixture.query, "personal");
  const need: StructuredNeed = {
    ...parsed,
    budgetKnown: fixture.budgetUsd != null,
    budgetUsd: fixture.budgetUsd,
    zip: fixture.zip,
    note: fixture.query,
  };
  const listings = fixture.listings.filter((row) => row.availability !== "sold").map(toListing);
  const marketPool = [...fixture.listings, ...fixture.comps].map(toListing);
  const bestDeal = selectBestDealOnEvidence({ need, listings, marketPool, nowYear: 2026 });
  const shortlistKeys = bestDeal.ranked
    .filter((row) => !row.excludedFromPick)
    .slice(0, shortlistSize)
    .map((row) => row.key);
  return { need, bestDeal, marketPool, listings, shortlistKeys };
}

/** Frozen stand-in for the agentic loop's result: code's top-ranked car, negotiate, high. */
function loopStandIn(built: ReturnType<typeof buildCase>) {
  const byVin = new Map<string, Listing>();
  for (const row of built.listings) if (row.vin) byVin.set(row.vin.toUpperCase(), row);
  const picks = built.shortlistKeys
    .map((key) => byVin.get(key.toUpperCase()))
    .filter((row): row is Listing => Boolean(row))
    .slice(0, 3)
    .map((row) => ({
      vin: row.vin!,
      label: `${row.year} ${row.make} ${row.model}`,
      action: "negotiate" as const,
      offerUsd: null,
      why: "frozen stand-in for the agentic loop's pick",
    }));
  if (picks.length === 0) return null;
  return mapFindAgentLoopToDecide({
    agent: {
      ok: true,
      agentMode: "tools",
      toolRounds: 0,
      verdictReached: true,
      verdict: { summary: "frozen loop stand-in", confidence: "high", picks, relaxedConditions: [], passReason: null },
      droppedPicks: [],
      listingsByVin: byVin,
      journal: [],
      relaxedConditions: [],
    } as never,
  });
}

function attemptFromCheck(
  repeat: number,
  out: FindGraphSecondCheckResult,
  ms: number,
  meter: ReturnType<typeof meteredFetch>["meter"],
): Attempt {
  const ok = out.secondPass.status === "agreed" || out.secondPass.status === "disagreed";
  return {
    arm: "loop_second_check",
    repeat,
    ok,
    usedGraph: out.ran,
    pickKey: out.graphFinal?.pickKey ?? null,
    action: out.graphFinal?.action ?? null,
    confidence: out.graphFinal?.confidence ?? null,
    secondPass: out.secondPass.status,
    latencyMs: ms,
    httpCalls: meter.calls,
    tokens: meter.tokens,
    costUsd: meter.costUsd,
    runIds: meter.runIds,
    failure: ok ? null : out.secondPass.objection,
    decidedBy: null,
    publishedPickKey: out.agentVerdict.pick?.key ?? null,
    publishedAction: out.agentVerdict.verdict,
  };
}

function attemptFromPrimary(
  repeat: number,
  out: FindGraphDecideResult,
  ms: number,
  meter: ReturnType<typeof meteredFetch>["meter"],
): Attempt {
  const ok = out.decidedBy === "graph" && out.graphFinal != null;
  return {
    arm: "graph_primary",
    repeat,
    ok,
    usedGraph: out.decidedBy === "graph",
    pickKey: out.graphFinal?.pickKey ?? out.agentVerdict.pick?.key ?? null,
    action: out.graphFinal?.action ?? null,
    confidence: out.graphFinal?.confidence ?? out.agentVerdict.confidence ?? null,
    secondPass: out.secondPass.status,
    latencyMs: ms,
    httpCalls: meter.calls,
    tokens: meter.tokens,
    costUsd: meter.costUsd,
    runIds: meter.runIds,
    failure: ok ? null : out.fallbackReason,
    decidedBy: out.decidedBy,
    publishedPickKey: out.agentVerdict.pick?.key ?? null,
    publishedAction: out.agentVerdict.verdict,
  };
}

/** Wrap fetch to count calls and read provider-returned usage. Never estimates. */
function meteredFetch() {
  const meter = { calls: 0, tokens: null as number | null, costUsd: null as number | null, runIds: [] as string[] };
  const impl: typeof fetch = async (input, init) => {
    meter.calls += 1;
    const res = await fetch(input, init);
    const runId = res.headers.get("x-openserv-request-id");
    if (runId) meter.runIds.push(runId);
    try {
      const body = (await res.clone().json()) as { usage?: Record<string, unknown> };
      const usage = body?.usage ?? {};
      const total = usage.total_tokens;
      if (typeof total === "number") meter.tokens = (meter.tokens ?? 0) + total;
      const cost = usage.cost ?? usage.cost_usd ?? usage.total_cost;
      if (typeof cost === "number") meter.costUsd = (meter.costUsd ?? 0) + cost;
    } catch {
      /* non-JSON body: usage unknown */
    }
    return res;
  };
  return { impl, meter };
}

function attemptFrom(arm: Arm, repeat: number, out: FindDecideServResult, ms: number, meter: ReturnType<typeof meteredFetch>["meter"]): Attempt {
  const decideProof = out.proofRecords.find((row) => row.purpose === "find_decide");
  const graphFallback = out.proofRecords.find((row) => row.purpose === "find_decide_graph");
  const usedGraph = Boolean(decideProof?.graph) && !graphFallback;
  const ok =
    decideProof?.status === "ok" &&
    out.source === "SERV" &&
    (out.secondPass.status === "agreed" || out.secondPass.status === "disagreed") &&
    (arm === "two_call" || usedGraph);
  return {
    arm,
    repeat,
    ok,
    usedGraph,
    pickKey: out.decide.pickKey || null,
    action: out.decide.action ?? null,
    confidence: out.decide.confidence ?? null,
    secondPass: out.secondPass.status,
    latencyMs: ms,
    httpCalls: meter.calls,
    tokens: meter.tokens,
    costUsd: meter.costUsd,
    runIds: meter.runIds,
    failure: ok ? null : graphFallback?.reason ?? decideProof?.reason ?? "no SERV decision",
    decidedBy: usedGraph ? "graph" : arm === "two_call" ? "two_call" : "fallback",
    publishedPickKey: out.decide.pickKey || null,
    publishedAction: out.decide.action ?? null,
  };
}

function modal(attempts: Attempt[]): string | null {
  const counts = new Map<string, number>();
  for (const a of attempts.filter((row) => row.ok)) {
    const key = `${a.pickKey}|${a.action}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best: string | null = null;
  let n = 0;
  for (const [key, c] of counts) if (c > n) [best, n] = [key, c];
  return best;
}

function pct(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

function sumOrNull(values: Array<number | null>): number | null {
  const known = values.filter((v): v is number => typeof v === "number");
  return known.length === values.length && known.length > 0 ? known.reduce((a, b) => a + b, 0) : null;
}

function loopPickLabel(built: ReturnType<typeof buildCase>): string | null {
  const loop = loopStandIn(built);
  return loop ? `${loop.agentVerdict.pick?.key ?? ""}|${loop.agentVerdict.verdict ?? ""}` : null;
}


function buildReport(
  rows: CaseRow[],
  args: Args,
  live: boolean,
  graphId: string | null,
  partial = false,
) {
  const all = rows.flatMap((row) => row.attempts);
  const summary = Object.fromEntries(
    args.arms.map((arm) => {
      const list = all.filter((a) => a.arm === arm);
      const consistency = rows
        .map((row) => {
          const mine = row.attempts.filter((a) => a.arm === arm && a.ok);
          const m = row.modal[arm];
          return mine.length > 0 && m ? mine.filter((a) => `${a.pickKey}|${a.action}` === m).length / mine.length : null;
        })
        .filter((v): v is number => v != null);
      return [
        arm,
        {
          attempts: list.length,
          validatorPassRate: list.length ? list.filter((a) => a.ok).length / list.length : null,
          repeatConsistency: consistency.length ? consistency.reduce((a, b) => a + b, 0) / consistency.length : null,
          latencyP50Ms: pct(list.map((a) => a.latencyMs), 50),
          latencyP95Ms: pct(list.map((a) => a.latencyMs), 95),
          httpCalls: list.reduce((a, b) => a + b.httpCalls, 0),
          tokens: sumOrNull(list.map((a) => a.tokens)),
          costUsd: sumOrNull(list.map((a) => a.costUsd)),
          graphFallbacks: arm === "graph" ? list.filter((a) => !a.usedGraph).length : null,
          secondCheckAgreed:
            arm === "loop_second_check" ? list.filter((a) => a.secondPass === "agreed").length : null,
          secondCheckDisagreed:
            arm === "loop_second_check" ? list.filter((a) => a.secondPass === "disagreed").length : null,
          graphDecided: arm === "graph_primary" ? list.filter((a) => a.decidedBy === "graph").length : null,
          fallbacks: arm === "graph_primary" ? list.filter((a) => a.decidedBy === "fallback").length : null,
          actionCounts: Object.fromEntries(
            ["buy", "negotiate", "inspect_first", "pass"].map((action) => [
              action,
              list.filter((a) => a.action === action).length,
            ]),
          ),
        },
      ];
    }),
  );
  const agreeRows = rows.filter((row) => row.agree != null);
  const primaryVsLoop = rows
    .map((row) => {
      const pub = row.attempts.filter((a) => a.arm === "graph_primary" && a.ok);
      if (pub.length === 0 || !row.loopPick) return null;
      const sameCar = pub.filter((a) => a.publishedPickKey && row.loopPick!.startsWith(`${a.publishedPickKey}|`)).length;
      const sameBoth = pub.filter((a) => `${a.publishedPickKey}|${a.publishedAction}` === row.loopPick).length;
      return { sameCar: sameCar / pub.length, sameBoth: sameBoth / pub.length };
    })
    .filter((v): v is { sameCar: number; sameBoth: number } => v != null);
  return {
    schemaVersion: "lemonless.graph_vs_baseline.v3",
    arms: args.arms,
    generatedAt: new Date().toISOString(),
    dryRun: !live,
    partial,
    graphId: live ? graphId : null,
    fixture: "eval/comparison/fixtures/find-cases.json",
    repeats: args.repeats,
    summary: {
      ...summary,
      decisionAgreement: agreeRows.length ? agreeRows.filter((row) => row.agree).length / agreeRows.length : null,
      graphPrimaryVsLoopStandIn:
        primaryVsLoop.length > 0
          ? {
              sameCar: primaryVsLoop.reduce((a, b) => a + b.sameCar, 0) / primaryVsLoop.length,
              sameCarAndAction: primaryVsLoop.reduce((a, b) => a + b.sameBoth, 0) / primaryVsLoop.length,
            }
          : null,
    },
    notes: [
      "Same fact sheet for both arms; public-record (free-gov) checks are not fetched in this eval.",
      "Token and cost fields are copied from provider responses only; null means not returned.",
      "Graph-arm attempts that fell back to the two-call path count as validator failures for the graph.",
      "loop_second_check is the previous production path (loop pick published, graph as second check).",
      "graph_primary is the new production path (graph publishes the pick; loop pick is fallback).",
      "The loop pick is a frozen stand-in (code's top-ranked car, negotiate, high).",
    ],
    cases: rows,
  };
}

function writePartial(
  outPath: string,
  completedRows: CaseRow[],
  currentAttempts: Attempt[],
  fixture: FindCaseFixture,
  built: ReturnType<typeof buildCase>,
  args: Args,
  live: boolean,
  graphId: string | null,
) {
  const current: CaseRow = {
    caseId: fixture.id,
    synthetic: fixture.synthetic,
    shortlistKeys: built.shortlistKeys,
    loopPick: loopPickLabel(built),
    modal: {
      two_call: modal(currentAttempts.filter((a) => a.arm === "two_call")),
      graph: modal(currentAttempts.filter((a) => a.arm === "graph")),
      loop_second_check: modal(currentAttempts.filter((a) => a.arm === "loop_second_check")),
      graph_primary: modal(currentAttempts.filter((a) => a.arm === "graph_primary")),
    },
    agree: null,
    attempts: currentAttempts,
  };
  const report = buildReport([...completedRows, current], args, live, graphId, true);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fixtures = (JSON.parse(readFileSync(FIXTURE, "utf8")) as { cases: FindCaseFixture[] }).cases.slice(
    0,
    args.cases ?? undefined,
  );
  const apiKey = process.env.SERV_API_KEY?.trim() || "";
  const graphId = findDecideGraphId();
  const paidOk = process.env.EVAL_GRAPH_ALLOW_PAID === "1" && Boolean(apiKey) && Boolean(graphId);
  if (args.live && !paidOk) {
    console.error(
      "Live run needs EVAL_GRAPH_ALLOW_PAID=1, SERV_API_KEY and SERV_GRAPH_FIND_DECIDE_ID=gr_… (values are not printed).",
    );
    process.exit(2);
  }
  const live = args.live && paidOk;

  const rows: CaseRow[] = [];
  for (const fixture of fixtures) {
    const built = buildCase(fixture, args.shortlist);
    const attempts: Attempt[] = [];
    if (live && built.shortlistKeys.length > 0) {
      for (const arm of args.arms) {
        for (let repeat = 1; repeat <= args.repeats; repeat += 1) {
          if (arm === "loop_second_check" || arm === "graph_primary") {
            const loop = loopStandIn(built);
            if (!loop) break;
            const { impl, meter } = meteredFetch();
            const started = Date.now();
            if (arm === "graph_primary") {
              const out = await runFindGraphDecide({
                need: built.need,
                bestDeal: loop.bestDeal,
                agentVerdict: loop.agentVerdict,
                shortlistKeys: loop.shortlistKeys,
                marketPool: built.marketPool,
                servKey: apiKey,
                fetchImpl: impl,
                remainingRouteMs: FIND_GRAPH_CHECK_MAX_MS + FIND_GRAPH_CHECK_SAFETY_MS,
                graphId,
              });
              attempts.push(attemptFromPrimary(repeat, out, Date.now() - started, meter));
            } else {
              const out = await runFindGraphSecondCheck({
                need: built.need,
                bestDeal: loop.bestDeal,
                agentVerdict: loop.agentVerdict,
                shortlistKeys: loop.shortlistKeys,
                marketPool: built.marketPool,
                servKey: apiKey,
                fetchImpl: impl,
                remainingRouteMs: FIND_GRAPH_CHECK_MAX_MS + FIND_GRAPH_CHECK_SAFETY_MS,
                graphId,
              });
              attempts.push(attemptFromCheck(repeat, out, Date.now() - started, meter));
            }
            console.log(`${fixture.id} ${arm} #${repeat}: ${attempts.at(-1)!.ok ? "ok" : "FAIL"}`);
            writePartial(args.out, rows, attempts, fixture, built, args, live, graphId);
            continue;
          }
          const { impl, meter } = meteredFetch();
          const started = Date.now();
          const out = await runFindDecideServ({
            need: built.need,
            bestDeal: built.bestDeal,
            shortlistKeys: built.shortlistKeys,
            receipts: [],
            marketPool: built.marketPool,
            servKey: apiKey,
            fetchImpl: impl,
            graphId: arm === "graph" ? graphId : null,
          });
          attempts.push(attemptFrom(arm, repeat, out, Date.now() - started, meter));
          console.log(`${fixture.id} ${arm} #${repeat}: ${attempts.at(-1)!.ok ? "ok" : "FAIL"}`);
          writePartial(args.out, rows, attempts, fixture, built, args, live, graphId);
        }
      }
    }
    const byArm = (arm: Arm) => attempts.filter((a) => a.arm === arm);
    const modalTwo = modal(byArm("two_call"));
    const modalGraph = modal(byArm("graph"));
    rows.push({
      caseId: fixture.id,
      synthetic: fixture.synthetic,
      shortlistKeys: built.shortlistKeys,
      loopPick: loopPickLabel(built),
      plannedCalls: live
        ? undefined
        : {
            two_call: args.arms.includes("two_call") ? 2 * args.repeats : 0,
            graph: args.arms.includes("graph") ? args.repeats : 0,
            loop_second_check: args.arms.includes("loop_second_check") ? args.repeats : 0,
            graph_primary: args.arms.includes("graph_primary") ? args.repeats : 0,
          },
      modal: { two_call: modalTwo, graph: modalGraph, loop_second_check: modal(byArm("loop_second_check")), graph_primary: modal(byArm("graph_primary")) },
      agree: modalTwo != null && modalGraph != null ? modalTwo === modalGraph : null,
      attempts,
    });
  }

  const report = buildReport(rows, args, live, live ? graphId : null, false);
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify(report, null, 2) + "\n");
  console.log(`${live ? "LIVE" : "DRY RUN (no HTTP, nothing spent)"}: ${rows.length} cases → ${args.out}`);
  console.log(JSON.stringify(report.summary, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
