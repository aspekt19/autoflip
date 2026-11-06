import { refusingPlanner, type ScoutPlanner } from "@/domain/scout";
import type { Kv } from "@/io/kv";
import { runServ } from "@/server/serv";
import {
  authorizeLiveServPlanner,
  readPaidExecutionConfig,
  type PaidSpendAuthority,
} from "./paid-execution";
import { parseScoutPlanText } from "./plan-parse";

/**
 * Live SERV planner via dedicated `scout_plan` profile (not flip_judge).
 * Actual request knobs come from profiles/requestFor (tools[] markers, model id,
 * response_format). Do not put serv_prompt_guard / shadow / multipath as user-text theater.
 * Do not use @openserv-labs/sdk Agent.process() — that hardcodes OpenAI gpt-4o, not SERV Reasoning.
 */
export function servScoutPlanner(deps: {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  kv?: Kv | null;
  testAuthority?: PaidSpendAuthority | null;
}): ScoutPlanner {
  const paid = authorizeLiveServPlanner({
    config: readPaidExecutionConfig(),
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

  return async (input) => {
    // Listing/tool state only in user message; policy stays in scout_plan system prompt.
    const user = JSON.stringify({
      task: "lemonless_scout_plan",
      mandate: input.mandate,
      pendingVins: input.pendingVins.slice(0, 40),
      investigatedVins: input.investigated.map((c) => c.vin),
      rejectedVins: input.rejected.map((c) => c.vin),
      step: input.step,
      evidenceHints: input.investigated.map((c) => ({
        vin: c.vin,
        historyStatus: c.historyStatus,
        disposition: c.disposition,
        askingUsd: c.listing.priceUsd,
      })),
    });

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
        },
      );
    } catch {
      return {
        ok: false,
        error: "serv_unavailable",
        message: "SERV planner threw before a response — stopping without deterministic autonomy fallback.",
      };
    }

    if (!result.ok) {
      const err = result.error.toLowerCase();
      if (err.includes("timeout")) {
        return { ok: false, error: "serv_timeout", message: result.error };
      }
      if (err.includes("refus") || result.status === 400) {
        return { ok: false, error: "serv_refused", message: result.error };
      }
      return { ok: false, error: "serv_unavailable", message: result.error };
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

export function blockedServPlanner(message?: string): ScoutPlanner {
  const base = refusingPlanner("serv_unavailable");
  if (!message) return base;
  return async () => ({
    ok: false,
    error: "serv_unavailable",
    message,
  });
}
