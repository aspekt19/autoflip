import { profile, PROFILES, type ProfileId } from "./profiles";
import { runServ, type ServDeps, type ServResult } from "./run";

/** Hobby serverless functions stop at 60s. Parallel checks must finish inside that. */
export const HOBBY_FUNCTION_MS = 60_000;

const CHEAP_USER = "2016 Toyota Camry.";
const CHEAP_FACTS = { year: 2016, make: "Toyota", model: "Camry", priceUsd: 12000, miles: 80000, compCount: 4, profitMidUsd: 500 };

/** One profile per distinct request shape: endpoint, suffix, tools, schema, stream, effort, tool, shadow cap. */
export function distinctSelftestProfiles(): ProfileId[] {
  const seen = new Set<string>();
  const ids: ProfileId[] = [];
  for (const id of Object.keys(PROFILES) as ProfileId[]) {
    const entry = profile(id);
    const key = [
      entry.endpoint,
      entry.feature,
      [...entry.tools].sort().join("+"),
      entry.jsonSchema?.name ?? "",
      entry.stream ? "stream" : "batch",
      entry.reasoningEffort,
      entry.applicationTool ?? "",
      entry.shadowMaxIterations ?? "",
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    ids.push(id);
  }
  return ids;
}

/** Worst-case wall clock when every shape runs at once. A figure-reading profile makes two requests. */
export function selftestWallClockMs(ids = distinctSelftestProfiles()): number {
  return Math.max(
    ...ids.map((id) => {
      const entry = profile(id);
      const rounds = entry.applicationTool && entry.endpoint === "chat" ? 2 : 1;
      return entry.timeoutMs * rounds;
    }),
    0,
  );
}

export const SELFTEST_PASS_RATE = 0.95;
export const SELFTEST_MAX_REPEAT = 5;

export function selftestRepeat(raw: string | null): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return 1;
  return Math.min(SELFTEST_MAX_REPEAT, parsed);
}

export type SelftestAttempt = {
  profile: ProfileId;
  attempt: number;
  ok: boolean;
  latencyMs: number;
  timeoutMs: number;
  withinTimeout: boolean;
  status: number;
  guardAccepted: boolean | null;
  shadowAccepted: boolean | null;
  suffixAccepted: boolean | null;
  error: string | null;
  upstream: string | null;
};

export type SelftestCheck = SelftestAttempt & {
  runs: number;
  passes: number;
  passRate: number;
  attempts: SelftestAttempt[];
};

async function oneAttempt(
  id: ProfileId,
  attempt: number,
  opts: { apiKey: string; model?: string; baseUrl?: string },
  run: (id: ProfileId, input: { user: string; facts?: unknown }, deps: ServDeps) => Promise<ServResult>,
): Promise<SelftestAttempt> {
  const entry = profile(id);
  const started = Date.now();
  const result = await run(id, { user: CHEAP_USER, facts: CHEAP_FACTS }, {
    apiKey: opts.apiKey,
    model: opts.model,
    baseUrl: opts.baseUrl,
  });
  const latencyMs = Date.now() - started;
  const status = result.ok ? result.rawStatus : result.status;
  const accepted = status !== 400 && status !== 403 && status !== 0;
  return {
    profile: id,
    attempt,
    ok: result.ok,
    latencyMs,
    timeoutMs: entry.timeoutMs,
    withinTimeout: latencyMs < entry.timeoutMs,
    status,
    guardAccepted: entry.tools.includes("prompt_guard") ? accepted : null,
    shadowAccepted: entry.tools.includes("shadow") ? accepted : null,
    suffixAccepted: entry.feature === "none" ? null : accepted,
    error: result.ok ? null : result.error,
    upstream: result.ok ? null : result.upstream ?? null,
  };
}

export async function runSelftestChecks(
  opts: { apiKey: string; model?: string; baseUrl?: string; repeat?: number },
  run: (id: ProfileId, input: { user: string; facts?: unknown }, deps: ServDeps) => Promise<ServResult> = runServ,
): Promise<SelftestCheck[]> {
  const repeat = selftestRepeat(opts.repeat == null ? null : String(opts.repeat));
  const ids = distinctSelftestProfiles();
  const attempts = await Promise.all(
    ids.flatMap((id) => Array.from({ length: repeat }, (_, index) => oneAttempt(id, index + 1, opts, run))),
  );
  return ids.map((id) => {
    const rows = attempts.filter((item) => item.profile === id);
    const passes = rows.filter((item) => item.ok).length;
    const last = rows[rows.length - 1]!;
    const passRate = rows.length === 0 ? 0 : passes / rows.length;
    return { ...last, ok: passRate >= SELFTEST_PASS_RATE, runs: rows.length, passes, passRate, attempts: rows };
  });
}
