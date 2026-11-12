import { BASE_MODEL, profile, type ProfileId } from "./profiles";
import { runServ, type ServDeps, type ServResult } from "./run";

export const PLAN_STOP_MESSAGE = "Our AI couldn't plan this search; no credit used. Try rephrasing.";
export const DECIDE_STOP_MESSAGE = "Our AI couldn't finish this decision; no credit used.";
export const SECOND_CHECK_MISSED = "Second check did not finish";

export type CallStepStatus = "ok" | "stopped" | "degraded";

export type CallStepOutcome = {
  status: CallStepStatus;
  result: ServResult;
  /** True when a non-critical step failed after its one retry. Confidence must be Low. */
  degraded: boolean;
  confidence: "low" | null;
  /** Buyer sentence. Set on stop and on a missed optional step. */
  message: string | null;
  reasonCode: string | null;
  retried: boolean;
};

type FailureKind = "ok" | "timeout" | "transport" | "refusal" | "other";

function reasonCodeOf(result: ServResult): string | null {
  return result.failureDiag?.reasonCode ?? null;
}

export function classifyServStepFailure(result: ServResult, accept?: (text: string) => boolean): FailureKind {
  if (result.ok) {
    const text = result.text?.trim() ?? "";
    if (!text) return "refusal";
    if (accept && !accept(text)) return "refusal";
    return "ok";
  }
  const transport = result.transportErrorClass;
  if (transport === "timeout" || transport === "abort") return "timeout";
  if (transport === "network") return "transport";
  if (result.status >= 500 && result.status < 600) return "transport";
  const reason = `${reasonCodeOf(result) ?? ""} ${result.error ?? ""}`;
  if (/refusal|empty_planner|content_null/i.test(reason) || result.status === 200) return "refusal";
  return "other";
}

/**
 * One SERV failure policy.
 * A timeout or a 5xx/network error is retried once on the same profile.
 * A refusal or a validation failure is retried once on bare gpt-6.1-sol.
 * A critical step that still fails stops the run: no charge, no code verdict.
 * An optional step that still fails is labeled and forces confidence Low.
 */
export async function callStep(input: {
  profileId: ProfileId;
  user: string;
  facts?: Record<string, unknown>;
  deps?: ServDeps;
  critical: boolean;
  /** When set, a 200 that fails this check is a refusal and is retried once. */
  accept?: (text: string) => boolean;
  run?: typeof runServ;
  /** Remaining wall clock. A timeout retry runs only when this is at least the profile timeout. */
  remainingMs?: number;
}): Promise<CallStepOutcome> {
  const run = input.run ?? runServ;
  const deps = input.deps ?? {};
  const payload = { user: input.user, facts: input.facts };
  const first = await run(input.profileId, payload, deps);
  let kind = classifyServStepFailure(first, input.accept);
  let result = first;
  let retried = false;

  const timeoutRoom =
    input.remainingMs == null || input.remainingMs >= profile(input.profileId).timeoutMs;

  if ((kind === "timeout" || kind === "transport") && timeoutRoom) {
    retried = true;
    result = await run(input.profileId, payload, deps);
    kind = classifyServStepFailure(result, input.accept);
  } else if (kind === "refusal") {
    retried = true;
    result = await run(input.profileId, payload, {
      ...deps,
      model: BASE_MODEL,
      disableFeatureSuffix: true,
      bareRetry: true,
    });
    kind = classifyServStepFailure(result, input.accept);
  }

  if (kind === "ok") {
    return { status: "ok", result, degraded: false, confidence: null, message: null, reasonCode: null, retried };
  }

  const reasonCode = reasonCodeOf(result);
  if (input.critical) {
    const message = input.profileId.includes("decide") || input.profileId.includes("pick")
      ? DECIDE_STOP_MESSAGE
      : PLAN_STOP_MESSAGE;
    return { status: "stopped", result, degraded: false, confidence: null, message, reasonCode, retried };
  }
  return {
    status: "degraded",
    result,
    degraded: true,
    confidence: "low",
    message: SECOND_CHECK_MISSED,
    reasonCode,
    retried,
  };
}
