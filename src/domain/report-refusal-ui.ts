/**
 * Client-side classification of /api/report refusal responses.
 * Hard refusals must show a clear reason and must not navigate as a completed report.
 */
export function isReportHardRefusal(input: {
  status: number;
  error?: string | null;
}): boolean {
  if (input.status === 422) return true;
  return (
    input.error === "unusable_purchase_ask" ||
    input.error === "missing_critical_input" ||
    input.error === "find_context_invalid"
  );
}

export function reportRefusalUserMessage(input: {
  message?: string | null;
  error?: string | null;
}): string {
  if (input.message && input.message.trim()) return input.message.trim();
  if (input.error === "find_context_invalid") {
    return "That find result is no longer trusted for full analysis. Run Find again and choose the same car. No credit was charged.";
  }
  if (input.error === "unusable_purchase_ask" || input.error === "missing_critical_input") {
    return "Full price analysis could not run for this listing. No credit was charged.";
  }
  return "Full analysis could not run. No credit was charged.";
}
