/**
 * Resale SERV call helper: pack allowlists like the working shopper path,
 * normalize id shapes, soft-filter evidence ids, and retry once on validation
 * reject (never on timeout — record measured latency instead).
 */
import {
  resaleCallTimeoutMs,
  RESALE_SERV_MIN_USEFUL_MS,
  type ResaleDeadline,
} from "@/domain/resale-deadline";
import {
  validateResaleServOutput,
  type ResaleEvidenceBundle,
  type ResaleServValidation,
} from "@/domain/resale-serv-validate";
import { profile, runServ, type ProfileId, type ServDeps, type ServResult } from "@/server/serv";

export function parseJsonObject(text: string | null | undefined): Record<string, unknown> | null {
  if (!text?.trim()) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Strip known citation prefixes models often echo into structured fields. */
export function stripKnownPrefix(raw: string, prefixes: string[]): string {
  const trimmed = raw.trim();
  for (const prefix of prefixes) {
    if (trimmed.toLowerCase().startsWith(prefix.toLowerCase())) {
      return trimmed.slice(prefix.length).trim();
    }
  }
  return trimmed;
}

export function normalizeDirectionId(raw: string): string {
  return stripKnownPrefix(raw, ["direction:"]);
}

export function normalizeCheckId(raw: string): string {
  return stripKnownPrefix(raw, ["check:"]);
}

export function normalizeVin(raw: string): string {
  return stripKnownPrefix(raw, ["vin:"]).toUpperCase();
}

/** Keep only evidence ids that appear in the allowlist (verdict_challenge style). */
export function softFilterEvidenceIds(
  ids: string[] | null | undefined,
  allowed: Iterable<string>,
): string[] {
  const allow = new Set([...allowed].map((id) => id.trim()).filter(Boolean));
  if (!ids?.length) return [];
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string") continue;
    const trimmed = id.trim();
    if (!trimmed) continue;
    if (allow.has(trimmed)) {
      out.push(trimmed);
      continue;
    }
    const asVin = `vin:${normalizeVin(trimmed)}`;
    if (allow.has(asVin)) {
      out.push(asVin);
      continue;
    }
    const asCheck = `check:${normalizeCheckId(trimmed)}`;
    if (allow.has(asCheck)) {
      out.push(asCheck);
      continue;
    }
    const asDirection = `direction:${normalizeDirectionId(trimmed)}`;
    if (allow.has(asDirection)) {
      out.push(asDirection);
    }
  }
  return out;
}

export function stringArrayField(payload: Record<string, unknown> | null, key: string): string[] {
  const raw = payload?.[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string");
}

export function isServTimeout(result: ServResult): boolean {
  if (result.ok) return false;
  const err = result.error ?? "";
  // status 0 is shared by timeout, not-configured, and model-allowlist failures —
  // only label timeout when the error text says so.
  return err === "SERV did not respond." || /timed?\s*out/i.test(err);
}

/**
 * Honest journal / UI reason for a failed SERV call.
 * Never describe a timeout as a validation/payload rejection.
 */
export function describeServCallFailure(result: ServResult): {
  why: string;
  rejected: string;
  isTimeout: boolean;
  latencyMs: number | null;
} {
  const latencyMs =
    typeof result.proof?.latencyMs === "number" && Number.isFinite(result.proof.latencyMs)
      ? Math.max(0, Math.round(result.proof.latencyMs))
      : null;
  if (isServTimeout(result)) {
    const secs = latencyMs != null && latencyMs > 0 ? Math.max(1, Math.round(latencyMs / 1000)) : null;
    return {
      why: secs != null ? `SERV timed out after ${secs}s` : "SERV timed out",
      rejected: "timeout",
      isTimeout: true,
      latencyMs,
    };
  }
  if (!result.ok) {
    const detail = result.error?.trim() || "call failed";
    // status 0 is transport/local failure (not configured, allowlist, abort) — not HTTP.
    if (!result.status) {
      return {
        why: `SERV call failed: ${detail}`,
        rejected: "call_failed",
        isTimeout: false,
        latencyMs,
      };
    }
    return {
      why: `SERV HTTP ${result.status}: ${detail}`,
      rejected: "http_error",
      isTimeout: false,
      latencyMs,
    };
  }
  return {
    why: "SERV call failed",
    rejected: "call_failed",
    isTimeout: false,
    latencyMs,
  };
}

export function describeServPayloadRejection(detail: string): {
  why: string;
  rejected: string;
} {
  const cleaned = detail.trim() || "unsupported reference";
  return {
    why: `SERV payload rejected: ${cleaned}`,
    rejected: "rejected: unsupported reference",
  };
}

export type ResaleServAttempt = {
  result: ServResult;
  payload: Record<string, unknown> | null;
  validation: ResaleServValidation;
  attempt: 1 | 2;
};

/**
 * Run a resale profile once. On successful HTTP with allowlist/schema rejection,
 * retry once with the validation error when budget/cap allow.
 * Never blind-retries timeouts — callers must journal measured latency instead.
 */
export async function runResaleServWithRejectRetry(input: {
  profileId: ProfileId;
  facts: unknown;
  /** Extra top-level fields (e.g. evidence pack) merged into the user JSON. */
  userExtra?: Record<string, unknown>;
  deps: ServDeps;
  deadline?: ResaleDeadline;
  /** Remaining SERV call slots after this first attempt (cap − current − 1). */
  canRetry: boolean;
  validatePayload: (payload: Record<string, unknown> | null, result: ServResult) => ResaleServValidation;
}): Promise<ResaleServAttempt> {
  const userBody = {
    facts: input.facts,
    ...input.userExtra,
  };
  const first = await runServ(input.profileId, { user: JSON.stringify(userBody) }, input.deps);
  // Payload only exists when HTTP succeeded with parseable text — never invent one for timeouts.
  const firstPayload = first.ok ? parseJsonObject(first.text) : null;
  const firstValidation = input.validatePayload(firstPayload, first);

  // No payload (timeout / HTTP / local): do not retry — journal measured latency / error.
  if (!first.ok || isServTimeout(first) || !firstPayload) {
    return { result: first, payload: firstPayload, validation: firstValidation, attempt: 1 };
  }
  if (firstValidation.ok || !input.canRetry) {
    return { result: first, payload: firstPayload, validation: firstValidation, attempt: 1 };
  }

  let retryTimeout = input.deps.timeoutMs;
  if (input.deadline) {
    const clamped = resaleCallTimeoutMs(
      profile(input.profileId).timeoutMs,
      input.deadline,
      RESALE_SERV_MIN_USEFUL_MS,
    );
    if (clamped == null) {
      return { result: first, payload: firstPayload, validation: firstValidation, attempt: 1 };
    }
    retryTimeout = clamped;
  }

  const second = await runServ(
    input.profileId,
    {
      user: JSON.stringify({
        ...userBody,
        previousRejection: firstValidation.detail,
        instruction:
          "Your previous JSON was rejected. Return JSON again that matches the schema. Use only allowlisted ids from facts (copy exact strings). Fix: " +
          firstValidation.detail,
      }),
    },
    { ...input.deps, timeoutMs: retryTimeout },
  );
  const secondPayload = second.ok ? parseJsonObject(second.text) : null;
  const secondValidation = input.validatePayload(secondPayload, second);
  // Retry got no payload (timeout/HTTP): keep the first payload rejection as journal truth.
  if ((!second.ok || isServTimeout(second) || !secondPayload) && !firstValidation.ok) {
    return { result: first, payload: firstPayload, validation: firstValidation, attempt: 2 };
  }
  return { result: second, payload: secondPayload, validation: secondValidation, attempt: 2 };
}

/** Build a validation that also requires HTTP ok + parseable payload. */
export function validationFromCall(input: {
  result: ServResult;
  payload: Record<string, unknown> | null;
  text?: string | null;
  vins?: string[] | null;
  urls?: string[] | null;
  evidenceIds?: string[] | null;
  bundle: ResaleEvidenceBundle;
}): ResaleServValidation {
  // Transport failure: do not pretend this is an allowlist/schema rejection.
  if (!input.result.ok || isServTimeout(input.result)) {
    const fail = describeServCallFailure(input.result);
    const reason =
      fail.rejected === "timeout" || fail.rejected === "http_error" || fail.rejected === "call_failed"
        ? fail.rejected
        : "call_failed";
    return {
      ok: false,
      reason,
      detail: fail.why,
    };
  }
  if (!input.payload) {
    return {
      ok: false,
      reason: "rejected: unsupported reference",
      detail: "Payload missing or not JSON.",
    };
  }
  return validateResaleServOutput(
    {
      text: input.text,
      vins: input.vins,
      urls: input.urls,
      evidenceIds: input.evidenceIds,
    },
    input.bundle,
  );
}

/**
 * Journal labeling:
 * - payload received but rejected → `rejected: unsupported reference` + `SERV payload rejected: …`
 * - no payload → timeout / HTTP / local call failure (never validation fallback text)
 */
export function journalWhyFromServAttempt(input: {
  result: ServResult;
  validation: ResaleServValidation;
  missingPayloadFallback: string;
  /** Parsed JSON when HTTP succeeded; null when there was no payload. */
  payload?: Record<string, unknown> | null;
}): { why: string; rejected: string | null } {
  const hadPayload = input.payload != null;
  // Payload present → content rejection wins over any transport wording on validation.detail.
  if (hadPayload && !input.validation.ok) {
    const rej = describeServPayloadRejection(input.validation.detail);
    return { why: rej.why, rejected: rej.rejected };
  }
  if (!input.result.ok || isServTimeout(input.result) || !hadPayload) {
    if (!input.result.ok || isServTimeout(input.result)) {
      const fail = describeServCallFailure(input.result);
      return { why: fail.why, rejected: fail.rejected };
    }
    return {
      why: input.missingPayloadFallback,
      rejected: "rejected: unsupported reference",
    };
  }
  if (!input.validation.ok) {
    const rej = describeServPayloadRejection(input.validation.detail);
    return { why: rej.why, rejected: rej.rejected };
  }
  return {
    why: input.missingPayloadFallback,
    rejected: "rejected: unsupported reference",
  };
}

/** Classify a shopper trace call the same way as other SERV steps. */
export function journalWhyFromShopperCall(call: {
  ok: boolean;
  error: string | null;
  latencyMs: number | null;
}): { why: string; rejected: string | null } {
  if (call.ok) return { why: "", rejected: null };
  const err = call.error?.trim() || "Shopper SERV call failed.";
  if (err === "SERV did not respond." || /timed?\s*out/i.test(err)) {
    const secs = call.latencyMs != null && call.latencyMs > 0 ? Math.max(1, Math.round(call.latencyMs / 1000)) : null;
    return {
      why: secs != null ? `SERV timed out after ${secs}s` : "SERV timed out",
      rejected: "timeout",
    };
  }
  const httpMatch = /HTTP\s+(\d{3})/i.exec(err);
  if (httpMatch) {
    return { why: `SERV HTTP ${httpMatch[1]}: ${err}`, rejected: "http_error" };
  }
  return { why: `SERV call failed: ${err}`, rejected: "call_failed" };
}
