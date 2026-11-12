import { BASE_MODEL, profile, type ProfileId } from "./profiles";
import { runServ, type ServDeps, type ServResult } from "./run";

export const PLAN_STOP_MESSAGE = "Our AI couldn't plan this search; no credit used. Try rephrasing.";
export const DECIDE_STOP_MESSAGE = "Our AI couldn't finish this decision; no credit used.";
export const SECOND_CHECK_MISSED = "Second check did not finish";

export type CallStepStatus = "ok" | "stopped" | "degraded";

export type ValidationIssue = { field: string; message: string };

export type ValidateResult = { ok: true } | { ok: false; issues: ValidationIssue[] };

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
  /** True when a validation-error repair call ran. */
  repaired: boolean;
  /** Issues from the last failed validate, or null when validate passed / was not used. */
  validationIssues: ValidationIssue[] | null;
  /** First JSON value when a successful answer was parseable; callers may ignore. */
  parsed?: unknown;
  /** Truncated rejected answer text when validation failed. */
  rejectedSample?: string | null;
};

type FailureKind = "ok" | "timeout" | "transport" | "refusal" | "other";

const REJECTED_SAMPLE_CHARS = 8000;

function reasonCodeOf(result: ServResult): string | null {
  return result.failureDiag?.reasonCode ?? null;
}

/** Log the full rejected SERV answer (capped) and the validation issues JSON. Never silent. */
export function logRejectedServAnswer(
  profileId: ProfileId | string,
  text: string | null | undefined,
  issues: ValidationIssue[],
): void {
  const sample = (text ?? "").slice(0, REJECTED_SAMPLE_CHARS);
  console.error(`[serv/${profileId}] rejected answer (${sample.length} chars): ${sample}`);
  console.error(`[serv/${profileId}] validation issues: ${JSON.stringify(issues)}`);
}

function rejectedSampleOf(text: string | null | undefined): string {
  return (text ?? "").slice(0, REJECTED_SAMPLE_CHARS);
}

/** Merge validationError into the original user JSON, or wrap when user is not JSON. */
export function buildValidationRepairUser(input: {
  user: string;
  facts?: Record<string, unknown>;
  issues: ValidationIssue[];
}): string {
  const validationError = {
    message: "Previous reply failed validation. Fix these issues and return JSON only.",
    issues: input.issues,
  };
  try {
    const parsed = JSON.parse(input.user) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const body = parsed as Record<string, unknown>;
      const merged: Record<string, unknown> = { ...body, validationError };
      if (input.facts) {
        const priorFacts =
          body.facts && typeof body.facts === "object" && !Array.isArray(body.facts)
            ? (body.facts as Record<string, unknown>)
            : {};
        merged.facts = { ...priorFacts, ...input.facts };
      }
      return JSON.stringify(merged);
    }
  } catch {
    // wrap below
  }
  return JSON.stringify({
    previousUser: input.user,
    ...(input.facts ? { facts: input.facts } : {}),
    validationError,
  });
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

function stopMessageFor(profileId: ProfileId): string {
  return profileId.includes("decide") || profileId.includes("pick")
    ? DECIDE_STOP_MESSAGE
    : PLAN_STOP_MESSAGE;
}

function failureOutcome(input: {
  critical: boolean;
  profileId: ProfileId;
  result: ServResult;
  retried: boolean;
  repaired: boolean;
  validationIssues: ValidationIssue[] | null;
  rejectedSample?: string | null;
}): CallStepOutcome {
  const reasonCode = reasonCodeOf(input.result);
  if (input.critical) {
    return {
      status: "stopped",
      result: input.result,
      degraded: false,
      confidence: null,
      message: stopMessageFor(input.profileId),
      reasonCode,
      retried: input.retried,
      repaired: input.repaired,
      validationIssues: input.validationIssues,
      rejectedSample: input.rejectedSample ?? null,
    };
  }
  return {
    status: "degraded",
    result: input.result,
    degraded: true,
    confidence: "low",
    message: SECOND_CHECK_MISSED,
    reasonCode,
    retried: input.retried,
    repaired: input.repaired,
    validationIssues: input.validationIssues,
    rejectedSample: input.rejectedSample ?? null,
  };
}

/**
 * One SERV failure policy.
 * 1. First call
 * 2. Timeout or 5xx/network → retry once on the same profile
 * 3. Refusal or empty → retry once on bare gpt-6.1-sol
 * 4. HTTP 200 but validate fails → log full reject + ONE repair with validationError
 * 5. Still failing → critical stops; optional degrades (confidence Low)
 */
export async function callStep(input: {
  profileId: ProfileId;
  user: string;
  facts?: Record<string, unknown>;
  deps?: ServDeps;
  critical: boolean;
  /** When set, a 200 that fails this check is a refusal and is retried once (compat). Prefer validate. */
  accept?: (text: string) => boolean;
  /** Structured validation. On fail: log + one repair call with validationError. */
  validate?: (text: string) => ValidateResult;
  run?: typeof runServ;
  /** Remaining wall clock. A timeout retry runs only when this is at least the profile timeout. */
  remainingMs?: number;
}): Promise<CallStepOutcome> {
  const run = input.run ?? runServ;
  const deps = input.deps ?? {};
  const payload = { user: input.user, facts: input.facts };
  const first = await run(input.profileId, payload, deps);
  // When validate is provided, leave schema checks to validate (not accept→refusal).
  const acceptForClassify = input.validate ? undefined : input.accept;
  let kind = classifyServStepFailure(first, acceptForClassify);
  let result = first;
  let retried = false;
  let repaired = false;
  let validationIssues: ValidationIssue[] | null = null;
  let rejectedSample: string | null = null;

  const timeoutRoom =
    input.remainingMs == null || input.remainingMs >= profile(input.profileId).timeoutMs;

  if ((kind === "timeout" || kind === "transport") && timeoutRoom) {
    retried = true;
    result = await run(input.profileId, payload, deps);
    kind = classifyServStepFailure(result, acceptForClassify);
  } else if (kind === "refusal" && !first.outputBudgetRetried) {
    retried = true;
    result = await run(input.profileId, payload, {
      ...deps,
      model: BASE_MODEL,
      disableFeatureSuffix: true,
      bareRetry: true,
    });
    kind = classifyServStepFailure(result, acceptForClassify);
  }

  if (kind === "ok" && input.validate) {
    const text = result.ok ? (result.text ?? "") : "";
    const firstCheck = input.validate(text);
    if (!firstCheck.ok) {
      validationIssues = firstCheck.issues;
      rejectedSample = rejectedSampleOf(text);
      logRejectedServAnswer(input.profileId, text, firstCheck.issues);
      repaired = true;
      const repairUser = buildValidationRepairUser({
        user: input.user,
        facts: input.facts,
        issues: firstCheck.issues,
      });
      result = await run(
        input.profileId,
        { user: repairUser, facts: input.facts },
        { ...deps, model: deps.model ?? BASE_MODEL },
      );
      if (result.ok && result.text?.trim()) {
        const secondCheck = input.validate(result.text);
        if (secondCheck.ok) {
          return {
            status: "ok",
            result,
            degraded: false,
            confidence: null,
            message: null,
            reasonCode: null,
            retried,
            repaired: true,
            validationIssues: null,
            rejectedSample: null,
          };
        }
        validationIssues = secondCheck.issues;
        rejectedSample = rejectedSampleOf(result.text);
        logRejectedServAnswer(input.profileId, result.text, secondCheck.issues);
      } else {
        rejectedSample = rejectedSampleOf(result.ok ? result.text : text);
        logRejectedServAnswer(
          input.profileId,
          result.ok ? result.text : text,
          firstCheck.issues,
        );
      }
      return failureOutcome({
        critical: input.critical,
        profileId: input.profileId,
        result,
        retried,
        repaired: true,
        validationIssues,
        rejectedSample,
      });
    }
  }

  if (kind === "ok") {
    return {
      status: "ok",
      result,
      degraded: false,
      confidence: null,
      message: null,
      reasonCode: null,
      retried,
      repaired,
      validationIssues: null,
      rejectedSample: null,
    };
  }

  return failureOutcome({
    critical: input.critical,
    profileId: input.profileId,
    result,
    retried,
    repaired,
    validationIssues,
    rejectedSample,
  });
}
