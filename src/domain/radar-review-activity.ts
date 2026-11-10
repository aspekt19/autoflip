/**
 * Pure helpers for Flip radar_review activity rows and alert outcomes.
 * Kept out of the cycle so tests can use the exact production row shape.
 */

export type RadarReviewDecision = { verdict: "alert" | "skip"; note: string };

export type RadarReviewFailureInput = {
  error: string;
  status: number;
  latencyMs: number;
  failureCategory?: string | null;
};

/** Map a failed runServ result into activity decision + note (never leave both null). */
export function radarReviewFailureFields(input: RadarReviewFailureInput): {
  decision: string;
  note: string;
} {
  const secs = input.latencyMs > 0 ? Math.max(1, Math.round(input.latencyMs / 1000)) : null;
  const timedOut =
    input.error === "SERV did not respond." ||
    input.status === 0 ||
    /timed?\s*out|timeout/i.test(input.error);
  if (timedOut) {
    return {
      decision: "timeout",
      note: secs != null ? `SERV timed out after ${secs}s` : "SERV timed out",
    };
  }
  if (input.status > 0) {
    return {
      decision: "http_error",
      note: `SERV HTTP ${input.status}: ${input.error}`,
    };
  }
  const category = input.failureCategory?.trim();
  return {
    decision: "error",
    note: category ? `${input.error} (${category})` : input.error,
  };
}

export type RadarReviewActivitySeed = {
  at: string;
  searchId: string;
  vin: string;
  callId: string;
  responseId: string | null;
  latencyMs: number;
  modelRequested: string;
  modelReported: string;
};

/**
 * Build one activity row per VIN for a single radar_review HTTP call.
 * Matches what judgeFlipAlerts stores — including failed calls with real failure text.
 */
export function buildRadarReviewActivityRows(
  seeds: RadarReviewActivitySeed[],
  judged: {
    ok: boolean;
    error?: string;
    status?: number;
    failureCategory?: string | null;
    decisions: Map<string, RadarReviewDecision> | null;
  },
): Array<{
  at: string;
  searchId: string;
  vin: string;
  profile: "radar_review";
  modelRequested: string;
  modelReported: string;
  callId: string;
  responseId: string | null;
  latencyMs: number;
  ok: boolean;
  decision: string | null;
  note: string | null;
  alerted: boolean;
}> {
  const failure =
    !judged.ok
      ? radarReviewFailureFields({
          error: judged.error ?? "SERV call failed.",
          status: judged.status ?? 0,
          latencyMs: seeds[0]?.latencyMs ?? 0,
          failureCategory: judged.failureCategory ?? null,
        })
      : null;

  return seeds.map((seed) => {
    const decision = judged.decisions?.get(seed.vin) ?? null;
    if (failure) {
      return {
        ...seed,
        profile: "radar_review" as const,
        ok: false,
        decision: failure.decision,
        note: failure.note,
        alerted: false,
      };
    }
    if (!judged.decisions) {
      return {
        ...seed,
        profile: "radar_review" as const,
        ok: true,
        decision: null,
        note: "No usable decision map in SERV response.",
        alerted: false,
      };
    }
    if (!decision) {
      return {
        ...seed,
        profile: "radar_review" as const,
        ok: true,
        decision: null,
        note: "No decision in this SERV response.",
        alerted: false,
      };
    }
    return {
      ...seed,
      profile: "radar_review" as const,
      ok: true,
      decision: decision.verdict,
      note: decision.note || null,
      alerted: decision.verdict === "alert",
    };
  });
}

export type FlipCandidateOutcome =
  | { kind: "alert"; whySuffix: string | null }
  | { kind: "serv_skipped"; why: string }
  | { kind: "not_reviewed"; why: string }
  | { kind: "code_alert"; why: string };

/**
 * Decide how a Flip candidate is stored after radar_review.
 * No decision map (SERV failed/empty) → not_reviewed for every car.
 */
export function flipCandidateOutcome(input: {
  hasServKey: boolean;
  decisions: Map<string, RadarReviewDecision> | null | undefined;
  vin: string;
  baseWhy: string;
}): FlipCandidateOutcome {
  if (!input.hasServKey) {
    return { kind: "code_alert", why: input.baseWhy };
  }
  if (!input.decisions) {
    return {
      kind: "not_reviewed",
      why: `Not reviewed (no SERV decision). ${input.baseWhy}`,
    };
  }
  const decision = input.decisions.get(input.vin);
  if (decision?.verdict === "skip") {
    return {
      kind: "serv_skipped",
      why: `Reviewed — skipped: ${decision.note?.trim() || input.baseWhy}`,
    };
  }
  if (decision?.verdict === "alert") {
    return { kind: "alert", whySuffix: decision.note?.trim() || null };
  }
  return {
    kind: "not_reviewed",
    why: `Not reviewed (no SERV decision). ${input.baseWhy}`,
  };
}

/** Replace an existing not_reviewed row for the same search+VIN, then unshift. */
export function upsertNotReviewedAlert<T extends { searchId: string; vin: string; status: string }>(
  alerts: T[],
  next: T,
): T[] {
  const without = alerts.filter(
    (row) => !(row.searchId === next.searchId && row.vin === next.vin && row.status === "not_reviewed"),
  );
  return [next, ...without];
}
