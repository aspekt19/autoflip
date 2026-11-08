/**
 * Live entrypoint for experimental sequential TWO-decision compare probe.
 *
 * Opt-in only (SCOUT_COMPARE_SEQUENTIAL=1 + paid gates in CLI). Tests inject
 * mock `fetch` via experimentServDeps — default zero HTTP when not called.
 * Max 2 experiment_single_attempt; 45s / 4096 parent bounds.
 */
import {
  loadPlaceholderLedger,
  runSequentialTwoDecision,
  type PlaceholderLedger,
  type SequentialAttemptUsage,
  type SequentialTwoDecisionResult,
} from "@/domain/scout/serv-model-compare";
import { buildScoutPlanUserMessage } from "./plan-user-message";
import { parseScoutPlanText } from "./plan-parse";
import { normalizeCompareUsageLoose } from "./plan-parse-diagnostics";
import {
  experimentServDeps,
  runServ,
  type ServDeps,
} from "@/server/serv";
import { profile } from "@/server/serv/profiles";

export type SequentialCompareProbeOpts = {
  ledger?: PlaceholderLedger;
  /** Model id for live/mock SERV (required when invoking HTTP). */
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  /** Injected fetch for mock HTTP tests — never hits network when provided. */
  fetch?: typeof fetch;
  timeoutMsPerAttempt?: number;
  outputTokenBound?: number;
  /** Extra ServDeps (transportPolicy forced to experiment_single_attempt). */
  servDeps?: Omit<ServDeps, "transportPolicy">;
};

function usageFromProof(proof: unknown): SequentialAttemptUsage | null {
  if (!proof || typeof proof !== "object") return null;
  const openserv = (proof as { openserv?: { usage?: unknown } }).openserv;
  // Loose normalize covers Gemini camelCase / alias shapes (parent telemetry gap).
  return normalizeCompareUsageLoose(openserv?.usage ?? null);
}

function openservMeta(proof: unknown): {
  id: string | null;
  finishReason: string | null;
} {
  if (!proof || typeof proof !== "object") return { id: null, finishReason: null };
  const openserv = (proof as { openserv?: { id?: unknown; finish_reason?: unknown } }).openserv;
  if (!openserv || typeof openserv !== "object") return { id: null, finishReason: null };
  return {
    id: typeof openserv.id === "string" && openserv.id.trim() ? openserv.id.trim() : null,
    finishReason:
      typeof openserv.finish_reason === "string" && openserv.finish_reason.trim()
        ? openserv.finish_reason.trim()
        : null,
  };
}

/**
 * Actual Decision-1 → local apply → Decision-2 orchestration via experiment_single_attempt.
 * This is the live entrypoint CLI uses when SCOUT_COMPARE_SEQUENTIAL=1 (with paid gates).
 */
export async function runSequentialCompareProbe(
  opts: SequentialCompareProbeOpts = {},
): Promise<SequentialTwoDecisionResult> {
  const scout = profile("scout_plan");
  const timeoutMsPerAttempt = opts.timeoutMsPerAttempt ?? scout.timeoutMs;
  const outputTokenBound = opts.outputTokenBound ?? 4096;
  const ledger = opts.ledger ?? loadPlaceholderLedger();

  const deps = experimentServDeps({
    ...opts.servDeps,
    apiKey: opts.apiKey ?? opts.servDeps?.apiKey ?? "test-key",
    baseUrl: opts.baseUrl ?? opts.servDeps?.baseUrl,
    model: opts.model ?? opts.servDeps?.model,
    timeoutMs: timeoutMsPerAttempt,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });

  return runSequentialTwoDecision({
    ledger,
    timeoutMsPerAttempt,
    outputTokenBound,
    buildUserMessage: buildScoutPlanUserMessage,
    parsePlanText: parseScoutPlanText,
    servCaller: async ({ userMessage }) => {
      const started = Date.now();
      const result = await runServ("scout_plan", { user: userMessage }, deps);
      const latencyMs = Date.now() - started;
      const tokens = usageFromProof(result.proof);
      const meta = openservMeta(result.proof);
      if (!result.ok) {
        return {
          httpAttempts: result.httpAttempts,
          text: null,
          ok: false,
          error: result.error,
          rawStatus: result.status,
          responseShape: result.responseShape,
          latencyMs,
          tokens,
          upstreamResponseId: meta.id,
          finishReason: meta.finishReason,
        };
      }
      return {
        httpAttempts: result.httpAttempts,
        text: result.text,
        ok: true,
        error: null,
        rawStatus: result.rawStatus,
        responseShape: result.responseShape,
        latencyMs,
        tokens,
        upstreamResponseId: meta.id,
        finishReason: meta.finishReason,
      };
    },
  });
}
