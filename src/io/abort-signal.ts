/**
 * Combine a caller AbortSignal with an ownership timeout for provider HTTP.
 * Mid-flight cancel from either source must abort the real fetch.
 */

export function combineAbortSignals(
  caller: AbortSignal | null | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!caller) return timeout;
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([caller, timeout]);
  }
  // Fallback for older runtimes: forward either abort onto a shared controller.
  const ctrl = new AbortController();
  const forward = () => {
    if (!ctrl.signal.aborted) ctrl.abort();
  };
  if (caller.aborted || timeout.aborted) {
    forward();
    return ctrl.signal;
  }
  caller.addEventListener("abort", forward, { once: true });
  timeout.addEventListener("abort", forward, { once: true });
  return ctrl.signal;
}
