import { refusingPlanner, type ScoutPlanner } from "@/domain/scout";
import { runServ } from "@/server/serv";

/**
 * Live SERV planner — only when explicitly allowed.
 * On refuse/timeout/unavailable: returns error (caller must STOP; no silent deterministic autonomy).
 * Parsing failures → serv_unavailable, not a hidden heuristic.
 */
export function servScoutPlanner(deps: {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}): ScoutPlanner {
  return async (input) => {
    const user = JSON.stringify({
      task: "lemonless_scout_plan",
      instruction:
        "Choose exactly one next action from the allowlist. Prefer evidence-backed investigation. Do not invent sold prices or verified history. Return JSON only.",
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

    const parsed = parsePlanJson(result.text);
    if (!parsed) {
      return {
        ok: false,
        error: "serv_unavailable",
        message: "SERV returned unparseable plan JSON — stopping (no silent heuristic fallback).",
      };
    }
    return { ok: true, action: parsed };
  };
}

function parsePlanJson(text: string): import("@/domain/scout").ScoutPlanAction | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    const type = raw.type;
    const reason = typeof raw.reason === "string" ? raw.reason : "SERV plan step";
    const servStepId = typeof raw.servStepId === "string" ? raw.servStepId : "serv-plan";
    if (type === "finalize" || type === "abstain") {
      return { type, reason, servStepId };
    }
    if (type === "reject" || type === "replace" || type === "select_candidate") {
      if (typeof raw.vin !== "string") return null;
      return { type, vin: raw.vin, reason, servStepId };
    }
    if (type === "run_tool") {
      if (typeof raw.toolId !== "string") return null;
      return {
        type,
        toolId: raw.toolId as import("@/domain/scout").ScoutToolId,
        vin: typeof raw.vin === "string" ? raw.vin : null,
        reason,
        servStepId,
        args: typeof raw.args === "object" && raw.args ? (raw.args as Record<string, unknown>) : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** Default production wiring until owner enables paid SERV planner. */
export function blockedServPlanner(): ScoutPlanner {
  return refusingPlanner("serv_unavailable");
}
