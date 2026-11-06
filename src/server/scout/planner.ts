import { refusingPlanner, type ScoutPlanner } from "@/domain/scout";
import { runServ } from "@/server/serv";
import { authorizeLiveServPlanner, readPaidExecutionConfig } from "./paid-execution";
import { parseScoutPlanText } from "./plan-parse";
import {
  SCOUT_PLAN_JSON_SCHEMA,
  resolveScoutServOptions,
  type ScoutServOptions,
} from "./serv-options";

/**
 * Live SERV planner — only when server paid-execution + SERV key authorize it.
 * On refuse/timeout/unavailable/parse failure: STOP (no silent deterministic autonomy).
 */
export function servScoutPlanner(deps: {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  options?: Partial<ScoutServOptions>;
}): ScoutPlanner {
  const options = resolveScoutServOptions(deps.options);
  const paid = authorizeLiveServPlanner(readPaidExecutionConfig());
  if (!paid.ok) {
    return async () => ({
      ok: false,
      error: "serv_unavailable",
      message: `Paid SERV planner blocked: ${paid.message}`,
    });
  }

  return async (input) => {
    const user = JSON.stringify({
      task: "lemonless_scout_plan",
      instruction:
        "Choose exactly one next action from the allowlist. Prefer evidence-backed investigation. Do not invent sold prices or verified history. Return JSON only matching the schema.",
      allowlist: [
        "select_candidate",
        "run_tool",
        "reject",
        "replace",
        "finalize",
        "abstain",
      ],
      tools: [
        "inventory.search",
        "listing.normalize",
        "evidence.asking_price",
        "evidence.comps_ask",
        "evidence.gov_recalls",
        "evidence.gov_fuel",
        "economics.flip_estimate",
        "economics.personal_fit",
        "gates.verify",
        "candidate.reject",
        "candidate.replace",
        "run.checkpoint",
        "run.finalize",
      ],
      mandate: input.mandate,
      pendingVins: input.pendingVins.slice(0, 40),
      investigatedVins: input.investigated.map((c) => c.vin),
      rejectedVins: input.rejected.map((c) => c.vin),
      step: input.step,
      featuresRequested: {
        promptGuard: options.promptGuard,
        shadowAgent: options.shadowAgent,
        strictJsonSchema: options.strictJsonSchema,
        kronos: options.kronos,
        multipath: options.multipath,
        reasoningEffort: options.reasoningEffort,
        contentFilterDefaultOn: options.contentFilterDefaultOn,
      },
      jsonSchema: options.strictJsonSchema ? SCOUT_PLAN_JSON_SCHEMA : null,
    });

    let result: Awaited<ReturnType<typeof runServ>>;
    try {
      result = await runServ(
        "flip_judge",
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
