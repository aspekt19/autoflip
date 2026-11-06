import type { ScoutPlanAction, ScoutToolId } from "@/domain/scout";
import { SCOUT_TOOL_IDS } from "@/domain/scout";

export type PlanParseResult =
  | { ok: true; action: ScoutPlanAction }
  | {
      ok: false;
      kind: "refusal" | "invalid_json" | "schema_mismatch" | "truncated";
      message: string;
    };

const REFUSAL_MARKERS = [
  "i can't share that",
  "i cannot share that",
  "i'm not able to",
  "i am not able to",
  "cannot assist with that",
  "can't assist with that",
];

function isToolId(value: unknown): value is ScoutToolId {
  return typeof value === "string" && (SCOUT_TOOL_IDS as readonly string[]).includes(value);
}

/**
 * App-side planner validation. Strict response_format still needs this
 * (docs: structured-outputs — validate + handle refusals/truncation separately).
 * Not a diagnosis of historical PR52 failures.
 */
export function parseScoutPlanText(text: string): PlanParseResult {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, kind: "truncated", message: "Empty SERV planner response." };
  }
  const lower = trimmed.toLowerCase();
  if (REFUSAL_MARKERS.some((m) => lower.includes(m)) && !trimmed.includes("{")) {
    return {
      ok: false,
      kind: "refusal",
      message: "SERV planner response looks like a refusal (not schema JSON).",
    };
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return { ok: false, kind: "invalid_json", message: "No JSON object in planner response." };
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return { ok: false, kind: "invalid_json", message: "Planner JSON parse failed." };
  }

  const type = raw.type;
  const reason = typeof raw.reason === "string" ? raw.reason : null;
  const servStepId = typeof raw.servStepId === "string" ? raw.servStepId : null;
  if (!reason || !servStepId) {
    return { ok: false, kind: "schema_mismatch", message: "Missing reason or servStepId." };
  }

  if (type === "finalize" || type === "abstain") {
    return { ok: true, action: { type, reason, servStepId } };
  }
  if (type === "reject" || type === "replace" || type === "select_candidate") {
    if (typeof raw.vin !== "string" || !raw.vin) {
      return { ok: false, kind: "schema_mismatch", message: `${type} requires vin.` };
    }
    return { ok: true, action: { type, vin: raw.vin, reason, servStepId } };
  }
  if (type === "run_tool") {
    if (!isToolId(raw.toolId)) {
      return { ok: false, kind: "schema_mismatch", message: "run_tool requires allowlisted toolId." };
    }
    return {
      ok: true,
      action: {
        type,
        toolId: raw.toolId,
        vin: typeof raw.vin === "string" ? raw.vin : null,
        reason,
        servStepId,
        args:
          raw.args && typeof raw.args === "object" && !Array.isArray(raw.args)
            ? (raw.args as Record<string, unknown>)
            : undefined,
      },
    };
  }
  return { ok: false, kind: "schema_mismatch", message: `Unknown action type: ${String(type)}` };
}
