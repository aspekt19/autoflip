const INTERNAL =
  /upstash|af_uid|auth\.js|firebase|email-link|sk_live|sk_test_|node_env|\bvercel\b|money_store|providerAccount|anonymousUserId|\buserId\b|https?:\/\//i;

/**
 * Copy that can be shown on a buyer page. Auth and storage failures stay plain.
 * Raw JSON, internal ids, and provider names fall back to the supplied sentence.
 */
export function buyerFacingFailure(
  error: string | null | undefined,
  message: string | null | undefined,
  fallback: string,
): string {
  if (error === "auth_unconfigured" || error === "money_store_unconfigured") {
    return "Sign-in is not available yet.";
  }
  if (error === "auth_required") return "Sign in to continue.";
  if (error === "email_required" || error === "email_unverified") {
    return "Use a verified email to continue.";
  }
  const text = message?.trim() ?? "";
  if (!text || text.startsWith("{") || text.startsWith("[") || INTERNAL.test(text)) return fallback;
  return text;
}
