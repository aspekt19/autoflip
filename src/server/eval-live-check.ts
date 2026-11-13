/**
 * Internal live-eval Check runners (link + VIN).
 * Same CRON auth as Find/Resale eval — never charges free-check quota or credits.
 */
import { isValidVin } from "@/domain/vin";
import { runtimeDeps } from "@/server/deps";
import { runCheck, type CheckResultPayload, type CheckRunResult } from "@/server/check/run-check";

export type EvalLiveCheckKind = "link" | "vin";

export type EvalLiveCheckResult = {
  id: string;
  kind: EvalLiveCheckKind;
  ok: boolean;
  blocked: boolean;
  charged: false;
  error: string | null;
  message: string | null;
  /** Full Check payload when ok; null on refusal/block. */
  check: CheckResultPayload | null;
  /** Raw non-ok envelope fields for report consumers. */
  refusal: Extract<CheckRunResult, { ok: false }> | null;
  elapsedMs: number;
};

export async function runEvalLiveCheck(input: {
  kind: EvalLiveCheckKind;
  listingUrl?: string | null;
  vin?: string | null;
  optionalZip?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<EvalLiveCheckResult> {
  const started = Date.now();
  const runtime = runtimeDeps();
  const fetchImpl = input.fetchImpl ?? fetch;
  const id =
    input.kind === "link"
      ? `check_link_${String(input.listingUrl ?? "").slice(0, 48)}`
      : `check_vin_${String(input.vin ?? "").trim().toUpperCase()}`;

  if (input.kind === "link") {
    const url = String(input.listingUrl ?? "").trim();
    if (!url || !/^https?:\/\//i.test(url)) {
      return {
        id,
        kind: "link",
        ok: false,
        blocked: false,
        charged: false,
        error: "invalid_listing_url",
        message: "listingUrl must be an http(s) URL.",
        check: null,
        refusal: null,
        elapsedMs: Date.now() - started,
      };
    }
    const result = await runCheck(
      { kind: "link", url, optionalZip: input.optionalZip ?? null },
      {
        fetch: fetchImpl,
        servKey: runtime.servKey!,
        servModel: runtime.servModel,
        servBaseUrl: runtime.servBaseUrl,
        autodevKey: runtime.autodevKey!,
        autodev: runtime.autodev,
      },
    );
    return settleCheckResult({ id, kind: "link", result, started });
  }

  const vin = String(input.vin ?? "").trim().toUpperCase();
  if (!isValidVin(vin)) {
    return {
      id,
      kind: "vin",
      ok: false,
      blocked: false,
      charged: false,
      error: "invalid_vin",
      message: "vin must be a checksum-valid 17-character VIN.",
      check: null,
      refusal: null,
      elapsedMs: Date.now() - started,
    };
  }
  const result = await runCheck(
    { kind: "vin", vin, optionalZip: input.optionalZip ?? null },
    {
      fetch: fetchImpl,
      servKey: runtime.servKey!,
      servModel: runtime.servModel,
      servBaseUrl: runtime.servBaseUrl,
      autodevKey: runtime.autodevKey!,
      autodev: runtime.autodev,
    },
  );
  return settleCheckResult({ id, kind: "vin", result, started });
}

function settleCheckResult(input: {
  id: string;
  kind: EvalLiveCheckKind;
  result: CheckRunResult;
  started: number;
}): EvalLiveCheckResult {
  const elapsedMs = Date.now() - input.started;
  if (input.result.ok) {
    return {
      id: input.id,
      kind: input.kind,
      ok: true,
      blocked: false,
      charged: false,
      error: null,
      message: null,
      check: input.result.result,
      refusal: null,
      elapsedMs,
    };
  }
  return {
    id: input.id,
    kind: input.kind,
    ok: false,
    blocked: input.result.blocked === true,
    charged: false,
    error: input.result.error,
    message: input.result.message,
    check: null,
    refusal: input.result,
    elapsedMs,
  };
}
