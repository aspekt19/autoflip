/**
 * Compare CLI paid-path dispatch — exclusive normal OR sequential.
 *
 * Root cause of 66b151e ≤2 bound breach: CLI ran normal model×steps compare
 * (3 HTTP) THEN sequential two-decision probe (2 HTTP) = 5 total when
 * SCOUT_COMPARE_SEQUENTIAL=1. Dispatch must XOR: never both.
 *
 * Production defaults unchanged. Offline / zero-HTTP when gates closed.
 */
import type { SequentialTwoDecisionResult } from "@/domain/scout/serv-model-compare";

/** Exclusive paid execution path for eval/serv-scout-model-compare.ts. */
export type CompareCliDispatchPath =
  | "dry_run"
  | "normal_compare"
  | "sequential_two_decision";

export type CompareCliDispatch = {
  path: CompareCliDispatchPath;
  /** Normal model×prepared-steps live loop. */
  runNormalCompare: boolean;
  /** Live sequential D1→apply→D2 probe (≤2 HTTP). */
  runSequentialLive: boolean;
  sequentialOptIn: boolean;
  live: boolean;
  /**
   * Max HTTP across the *entire* CLI invocation for this dispatch.
   * sequential_two_decision → 2; normal_compare → unbounded by this module
   * (per-step experiment_single_attempt still applies); dry_run → 0.
   */
  maxHttpAttemptsTotal: number | null;
};

/**
 * Resolve exclusive CLI dispatch from gates.
 * SCOUT_COMPARE_SEQUENTIAL=1 + live → sequential only (no normal rows).
 * live without sequential → normal compare only.
 * Otherwise dry_run (offline fixtures may still run; zero HTTP).
 */
export function resolveCompareCliDispatch(input: {
  live: boolean;
  sequentialOptIn: boolean;
}): CompareCliDispatch {
  const sequentialOptIn = Boolean(input.sequentialOptIn);
  const live = Boolean(input.live);
  if (live && sequentialOptIn) {
    return {
      path: "sequential_two_decision",
      runNormalCompare: false,
      runSequentialLive: true,
      sequentialOptIn,
      live,
      maxHttpAttemptsTotal: 2,
    };
  }
  if (live) {
    return {
      path: "normal_compare",
      runNormalCompare: true,
      runSequentialLive: false,
      sequentialOptIn,
      live,
      maxHttpAttemptsTotal: null,
    };
  }
  return {
    path: "dry_run",
    runNormalCompare: false,
    runSequentialLive: false,
    sequentialOptIn,
    live,
    maxHttpAttemptsTotal: 0,
  };
}

/**
 * Parent-supplied source attestation (JSON via SCOUT_COMPARE_SOURCE_PIN).
 * Invalid / absent → null (honest; never invent head/tree).
 */
export function resolveCompareSourcePin(
  env: NodeJS.Dict<string> | Record<string, string | undefined> = process.env,
): Record<string, unknown> | null {
  const raw = typeof env.SCOUT_COMPARE_SOURCE_PIN === "string" ? env.SCOUT_COMPARE_SOURCE_PIN.trim() : "";
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export type CompareCliPaidPathResult = {
  dispatch: CompareCliDispatch;
  /** Live normal-compare HTTP attempts (0 when sequential XOR or dry). */
  normalHttpAttempts: number;
  /** Live sequential HTTP attempts (0 when normal XOR or dry). */
  sequentialHttpAttempts: number;
  /** Sum across the full invocation. */
  httpAttemptsTotal: number;
  sequentialLive: SequentialTwoDecisionResult | null;
  /** True when sequential bound would have been violated (fail-closed signal). */
  sequentialBoundExceeded: boolean;
};

/**
 * Execute the paid path under XOR dispatch.
 * Callers supply the normal-compare and sequential runners; this module
 * guarantees at most one of them runs and totals HTTP across the invocation.
 */
export async function executeCompareCliPaidPath(input: {
  dispatch: CompareCliDispatch;
  runNormalCompare?: () => Promise<{ httpAttempts: number }>;
  runSequentialLive?: () => Promise<SequentialTwoDecisionResult>;
}): Promise<CompareCliPaidPathResult> {
  const { dispatch } = input;
  let normalHttpAttempts = 0;
  let sequentialHttpAttempts = 0;
  let sequentialLive: SequentialTwoDecisionResult | null = null;

  if (dispatch.runNormalCompare && dispatch.runSequentialLive) {
    throw new Error(
      "compare CLI dispatch invariant violated: normal_compare and sequential_two_decision both selected",
    );
  }

  if (dispatch.runNormalCompare) {
    if (!input.runNormalCompare) {
      throw new Error("compare CLI dispatch: normal_compare selected but runner missing");
    }
    const normal = await input.runNormalCompare();
    normalHttpAttempts = Math.max(0, normal.httpAttempts);
  } else if (dispatch.runSequentialLive) {
    if (!input.runSequentialLive) {
      throw new Error("compare CLI dispatch: sequential_two_decision selected but runner missing");
    }
    sequentialLive = await input.runSequentialLive();
    sequentialHttpAttempts = Math.max(0, sequentialLive.httpAttemptsTotal);
  }

  const httpAttemptsTotal = normalHttpAttempts + sequentialHttpAttempts;
  const sequentialBoundExceeded =
    dispatch.path === "sequential_two_decision" &&
    dispatch.maxHttpAttemptsTotal != null &&
    httpAttemptsTotal > dispatch.maxHttpAttemptsTotal;

  if (sequentialBoundExceeded) {
    throw new Error(
      `compare CLI sequential bound exceeded: ${httpAttemptsTotal} > ${dispatch.maxHttpAttemptsTotal} HTTP across full invocation`,
    );
  }

  return {
    dispatch,
    normalHttpAttempts,
    sequentialHttpAttempts,
    httpAttemptsTotal,
    sequentialLive,
    sequentialBoundExceeded: false,
  };
}
