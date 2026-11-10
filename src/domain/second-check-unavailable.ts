/**
 * Buyer-facing short reason when verdict_challenge fails.
 * Keep the raw upstream dump out of the primary label.
 */

export function shortSecondCheckUnavailableReason(input: {
  error?: string | null;
  upstream?: string | null;
  status?: number | null;
  reasonCode?: string | null;
}): string {
  const code = (input.reasonCode ?? "").trim();
  const err = (input.error ?? "").trim().toLowerCase();
  const upstream = (input.upstream ?? "").trim().toLowerCase();

  if (
    code === "message_content_null_refusal_field" ||
    code === "message_refusal_field_empty_content" ||
    /structured refusal|refusal_field|content_null_refusal/i.test(err)
  ) {
    return "model returned a refusal with no usable answer";
  }
  if (code.includes("timeout") || /timed?\s*out|timeout/i.test(err) || upstream.includes("timeout")) {
    return "timed out";
  }
  if (code === "empty_content" || upstream === "empty_text" || /empty explanation|empty (body|content|response)/i.test(err)) {
    return "empty response";
  }
  if (typeof input.status === "number" && input.status >= 500) {
    return `upstream HTTP ${input.status}`;
  }
  if (typeof input.status === "number" && input.status >= 400) {
    return `HTTP ${input.status}`;
  }
  if (upstream) return upstream.replace(/_/g, " ");
  if (input.error?.trim()) {
    const first = input.error.trim().split(/[.\n]/)[0]?.trim();
    if (first && first.length <= 80) return first.replace(/^SERV\s+/i, "");
  }
  return "second check did not finish";
}

/** Primary UI / journal label. */
export function secondCheckUnavailableLabel(shortReason: string): string {
  return `Second check unavailable: ${shortReason}`;
}

/** Join raw diagnostic bits for a collapsible dump only. */
export function secondCheckUnavailableRawDump(parts: Array<string | null | undefined>): string | null {
  const cleaned = parts.map((p) => (typeof p === "string" ? p.trim() : "")).filter(Boolean);
  return cleaned.length ? cleaned.join(" · ") : null;
}
