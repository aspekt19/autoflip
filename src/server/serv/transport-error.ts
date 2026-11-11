/**
 * Classify SERV transport failures for honest proof/journal detail.
 * Never includes stack traces, URLs with secrets, or raw response bodies.
 */

export type ServTransportErrorClass = "timeout" | "abort" | "network" | "http_5xx" | "http_4xx" | "unknown";

export function classifyServTransportError(error: unknown): {
  class: ServTransportErrorClass;
  /** Plain-language detail safe for proof records / buyer journal scrubbing. */
  detail: string;
} {
  if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) {
    const timedOut = error.name === "TimeoutError" || /timeout/i.test(error.message);
    return {
      class: timedOut ? "timeout" : "abort",
      detail: timedOut
        ? "SERV call timed out waiting for a response."
        : "SERV call was aborted before a response arrived.",
    };
  }
  if (error instanceof Error) {
    const name = error.name || "";
    const msg = error.message || "";
    if (name === "AbortError" || name === "TimeoutError" || /aborted|timeout|timed?\s*out/i.test(msg)) {
      const timedOut = name === "TimeoutError" || /timeout|timed?\s*out/i.test(msg);
      return {
        class: timedOut ? "timeout" : "abort",
        detail: timedOut
          ? "SERV call timed out waiting for a response."
          : "SERV call was aborted before a response arrived.",
      };
    }
    if (/fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|socket|network/i.test(msg)) {
      return { class: "network", detail: "SERV network error — the request never completed." };
    }
    return { class: "unknown", detail: "SERV did not respond." };
  }
  return { class: "unknown", detail: "SERV did not respond." };
}

/**
 * True when a failed SERV result is worth one honest retry.
 * Retry on network / 5xx / unparseable / invalid output only — not on timeout/abort.
 * With generous per-call timeouts (e.g. 90s), retrying a timeout would blow the route budget;
 * do not use short timeouts as a retry shortcut.
 */
export function isServRetryableFailure(input: {
  ok: boolean;
  status?: number;
  errorClass?: ServTransportErrorClass | null;
  unparseable?: boolean;
  validationFailed?: boolean;
}): boolean {
  if (input.ok) return false;
  if (input.unparseable || input.validationFailed) return true;
  if (input.errorClass === "network") return true;
  if (input.errorClass === "timeout" || input.errorClass === "abort") return false;
  const status = input.status ?? 0;
  if (status >= 500 && status < 600) return true;
  return false;
}
