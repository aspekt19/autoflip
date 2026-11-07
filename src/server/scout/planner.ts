import { refusingPlanner, type ScoutPlanner } from "@/domain/scout";
import type { Kv } from "@/io/kv";
import { runServ } from "@/server/serv";
import {
  authorizeLiveServPlanner,
  readPaidExecutionConfig,
  type PaidSpendAuthority,
} from "./paid-execution";
import { loadOwnerGrant, reserveGrantProviderCall } from "./owner-grant";
import { parseScoutPlanText } from "./plan-parse";

/**
 * Live SERV planner via dedicated `scout_plan` profile (not flip_judge).
 * Actual request knobs come from profiles/requestFor (tools[] markers, model id,
 * response_format). Do not put serv_prompt_guard / shadow / multipath as user-text theater.
 * Do not use @openserv-labs/sdk Agent.process() — that hardcodes OpenAI gpt-4o, not SERV Reasoning.
 *
 * Owner-grant SERV: every outbound HTTP (including finalize/replan/retry rounds inside
 * runServ) atomically reserves one grant call BEFORE dispatch. Ambiguous failures after
 * dispatch retain the reservation (no refund). Exhaustion fails closed as serv_unavailable.
 */
export function servScoutPlanner(deps: {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  kv?: Kv | null;
  testAuthority?: PaidSpendAuthority | null;
  /**
   * Caller-supplied paid config (from executeScoutSafely env). When omitted,
   * falls back to process.env — tests must pass config so stubbed env is honored.
   */
  config?: ReturnType<typeof readPaidExecutionConfig>;
  env?: Record<string, string | undefined>;
}): ScoutPlanner {
  const paid = authorizeLiveServPlanner({
    config: deps.config ?? readPaidExecutionConfig(deps.env),
    kv: deps.kv ?? null,
    testAuthority: deps.testAuthority ?? null,
  });
  if (!paid.ok) {
    return async () => ({
      ok: false,
      error: "serv_unavailable",
      message: `Paid SERV planner blocked: ${paid.message}`,
    });
  }

  const grantId =
    deps.testAuthority?.kind === "owner_grant" ? deps.testAuthority.grantId ?? null : null;

  return async (input) => {
    // Listing/tool state only in user message; policy stays in scout_plan system prompt.
    // Stage2C: bounded facts/missingness/gates/confidence + search history (not VIN-walk only).
    const user = JSON.stringify({
      task: "lemonless_scout_plan",
      mandate: input.mandate,
      pendingVins: input.pendingVins.slice(0, 40),
      investigatedVins: input.investigated.map((c) => c.vin),
      rejectedVins: input.rejected.map((c) => c.vin),
      step: input.step,
      recentOutcomes: input.evidenceContext.recentOutcomes,
      evidenceContext: {
        evidenceBriefs: input.evidenceContext.evidenceBriefs,
        searchHistory: input.evidenceContext.searchHistory,
        budgetsRemaining: input.evidenceContext.budgetsRemaining,
        pendingAskSummary: input.evidenceContext.pendingAskSummary,
        policy: input.evidenceContext.policy,
      },
      // Legacy thin hints retained for older parsers — prefer evidenceContext.
      evidenceHints: input.evidenceContext.evidenceBriefs.map((c) => ({
        vin: c.vin,
        historyStatus: c.historyStatus,
        disposition: c.disposition,
        askingUsd: c.askingUsd,
        askingPriceUsable: c.askingPriceUsable,
        freeGovCanUnlockInvestigate: c.freeGovCanUnlockInvestigate,
        withheld: c.withheld,
        confidence: c.confidence,
        missingness: c.missingness,
        unsupportedGovAloneNotBad: true,
        placeholderAskIsNotVehicleDefect: true,
      })),
    });

    const beforeHttp =
      grantId && deps.kv
        ? async () => {
            const grant = await loadOwnerGrant(deps.kv!, grantId);
            if (!grant) {
              return {
                ok: false as const,
                message: "Owner grant missing at SERV reserve time — failing closed.",
              };
            }
            const reserved = await reserveGrantProviderCall(deps.kv!, grant, "serv");
            if (!reserved.ok) {
              return { ok: false as const, message: reserved.message };
            }
            return { ok: true as const };
          }
        : undefined;

    let result: Awaited<ReturnType<typeof runServ>>;
    try {
      result = await runServ(
        "scout_plan",
        { user },
        {
          apiKey: deps.apiKey,
          baseUrl: deps.baseUrl,
          model: deps.model,
          timeoutMs: deps.timeoutMs ?? 45_000,
          fetch: deps.fetch,
          beforeHttp,
        },
      );
    } catch {
      // Ambiguous — if beforeHttp already reserved, reservation stands (no refund here).
      return {
        ok: false,
        error: "serv_unavailable",
        message: "SERV planner threw before a response — stopping without deterministic autonomy fallback.",
      };
    }

    if (!result.ok) {
      const err = result.error.toLowerCase();
      const diagnostic =
        typeof result.upstream === "string" && result.upstream.trim()
          ? sanitizePlannerDiagnostic(result.upstream, result.status)
          : result.status > 0
            ? `SERV HTTP ${result.status}`
            : null;
      if (result.status === 429 || err.includes("grant") || err.includes("call cap")) {
        return {
          ok: false,
          error: "serv_unavailable",
          message: result.error,
          diagnostic,
        };
      }
      if (err.includes("timeout")) {
        return { ok: false, error: "serv_timeout", message: result.error, diagnostic };
      }
      if (err.includes("refus") || result.status === 400) {
        return { ok: false, error: "serv_refused", message: result.error, diagnostic };
      }
      return { ok: false, error: "serv_unavailable", message: result.error, diagnostic };
    }

    const parsed = parseScoutPlanText(result.text);
    if (!parsed.ok) {
      const error =
        parsed.kind === "refusal" ? ("serv_refused" as const) : ("serv_unavailable" as const);
      return {
        ok: false,
        error,
        message: `SERV planner ${parsed.kind}: ${parsed.message} — stopping (no silent heuristic fallback).`,
      };
    }
    return { ok: true, action: parsed.action };
  };
}

/** Strip secrets and keep actionable schema/status hints for operators. */
export function sanitizePlannerDiagnostic(upstream: string, status: number): string {
  const cleaned = upstream
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/\baf_[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
  const prefix = status > 0 ? `SERV HTTP ${status}` : "SERV";
  return cleaned ? `${prefix}: ${cleaned}` : prefix;
}

export function blockedServPlanner(message?: string): ScoutPlanner {
  const base = refusingPlanner("serv_unavailable");
  if (!message) return base;
  return async () => ({
    ok: false,
    error: "serv_unavailable" as const,
    message,
  });
}
