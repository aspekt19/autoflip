import type { ScoutPlanAction, ScoutToolId } from "@/domain/scout";
import { SCOUT_TOOL_IDS } from "@/domain/scout";
import { reasonServStepIdMismatchMessage } from "./plan-parse-diagnostics";

export type PlanParseResult =
  | { ok: true; action: ScoutPlanAction }
  | {
      ok: false;
      kind: "refusal" | "invalid_json" | "schema_mismatch" | "truncated";
      message: string;
    };

export {
  sanitizePlannerParseEcho,
  reasonServStepIdMismatchMessage,
  normalizeCompareUsage,
  type SanitizedPlannerParseEcho,
  type FieldPresence,
  type CompareUsage,
} from "./plan-parse-diagnostics";

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

const CITED_KINDS = new Set([
  "bad_title_brand",
  "over_budget",
  "over_miles",
  "flip_excluded",
  "missing_asking_price",
  "economics_estimate",
  "nhtsa_park_it",
]);

function parseCitedEvidence(
  raw: unknown,
): Array<{ kind: string; gateId?: string }> | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const out: Array<{ kind: string; gateId?: string }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.kind !== "string" || !CITED_KINDS.has(rec.kind)) continue;
    out.push({
      kind: rec.kind,
      ...(typeof rec.gateId === "string" && rec.gateId ? { gateId: rec.gateId } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Execution-owned correlation id for provenance / acquiredBy / outcome stamps.
 *
 * Not a model decision: action fingerprint + tool idempotency keys do not use it,
 * and request schema no longer asks the model to invent one (Sonnet PR71 empty_string
 * class). Prefer `exec:step-${n}` from the runner loop when binding live plans.
 */
export function allocateExecutionServStepId(step?: number): string {
  if (typeof step === "number" && Number.isFinite(step) && step >= 0) {
    return `exec:step-${Math.trunc(step)}`;
  }
  allocateExecutionServStepIdSeq += 1;
  return `exec:auto-${allocateExecutionServStepIdSeq}`;
}

let allocateExecutionServStepIdSeq = 0;

/** Test-only — reset auto counter for deterministic offline fixtures. */
export function resetExecutionServStepIdSeqForTests(): void {
  allocateExecutionServStepIdSeq = 0;
}

export type ParseScoutPlanOptions = {
  /**
   * Correlation id stamped by execution. Model-emitted `servStepId` is ignored
   * when present (legacy / stray fields) — ownership stays with the runtime.
   */
  executionServStepId?: string;
};

/**
 * App-side planner validation. Strict response_format still needs this
 * (docs: structured-outputs — validate + handle refusals/truncation separately).
 * Not a diagnosis of historical PR52 failures.
 *
 * Decision fields (model-owned): type, reason, vin, toolId, args, rationale*, cited*.
 * Correlation (execution-owned): servStepId — bound here, never required from the model.
 */
export function parseScoutPlanText(
  text: string,
  opts?: ParseScoutPlanOptions,
): PlanParseResult {
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
  const reason = typeof raw.reason === "string" ? raw.reason.trim() : null;
  if (!reason) {
    // Keep stable prefix for metrics regexes; append field presence so compare
    // rows can tell null / empty / missing / wrong-shape apart without raw text.
    // servStepId presence in the echo is forensic only — not a decision failure.
    return {
      ok: false,
      kind: "schema_mismatch",
      message: reasonServStepIdMismatchMessage(raw),
    };
  }

  const bound = opts?.executionServStepId?.trim();
  const servStepId = bound || allocateExecutionServStepId();

  if (type === "finalize" || type === "abstain") {
    return { ok: true, action: { type, reason, servStepId } };
  }
  if (type === "reject" || type === "replace" || type === "select_candidate") {
    if (typeof raw.vin !== "string" || !raw.vin) {
      return { ok: false, kind: "schema_mismatch", message: `${type} requires vin.` };
    }
    const rationaleKind =
      raw.rationaleKind === "adverse_evidence" || raw.rationaleKind === "uncertainty_progress"
        ? raw.rationaleKind
        : undefined;
    if (type === "select_candidate") {
      return { ok: true, action: { type, vin: raw.vin, reason, servStepId } };
    }
    const citedEvidence = parseCitedEvidence(raw.citedEvidence);
    const assumptionsDisclosed =
      typeof raw.assumptionsDisclosed === "boolean" ? raw.assumptionsDisclosed : undefined;
    return {
      ok: true,
      action: {
        type,
        vin: raw.vin,
        reason,
        servStepId,
        ...(rationaleKind ? { rationaleKind } : {}),
        ...(citedEvidence ? { citedEvidence } : {}),
        ...(assumptionsDisclosed != null ? { assumptionsDisclosed } : {}),
      },
    };
  }
  if (type === "run_tool") {
    if (!isToolId(raw.toolId)) {
      return { ok: false, kind: "schema_mismatch", message: "run_tool requires allowlisted toolId." };
    }
    let args: Record<string, unknown> | undefined;
    if (raw.args && typeof raw.args === "object" && !Array.isArray(raw.args)) {
      // Strict schema emits every key (null unions). Drop null/undefined so
      // validateScoutSearchParams can apply mandate defaults for omitted fields.
      const cleaned: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(raw.args as Record<string, unknown>)) {
        if (value !== null && value !== undefined) cleaned[key] = value;
      }
      if (Object.keys(cleaned).length > 0) args = cleaned;
    }
    return {
      ok: true,
      action: {
        type,
        toolId: raw.toolId,
        vin: typeof raw.vin === "string" ? raw.vin : null,
        reason,
        servStepId,
        ...(args ? { args } : {}),
      },
    };
  }
  return { ok: false, kind: "schema_mismatch", message: `Unknown action type: ${String(type)}` };
}
