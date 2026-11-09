const CONTROL = /[\u0000-\u001F\u007F]/;

/** One Lemonless user per lowercased verified email (Google and email-link). */
export function canonicalAccountEmail(email: string): string | null {
  const normalized = email.trim().toLowerCase().normalize("NFC");
  if (!normalized.includes("@") || normalized.startsWith("@") || normalized.endsWith("@")) return null;
  if (normalized.split("@").length !== 2) return null;
  if (normalized.includes(" ") || CONTROL.test(normalized) || normalized.length > 200) return null;
  return normalized;
}

/**
 * Google may join an existing email-link user only when this sign-in itself
 * asserts email_verified and the address matches the account we would use.
 * A string "true" or a mismatched address is not a verified Google email.
 */
export function verifiedGoogleEmail(
  profile: { email?: string | null; email_verified?: unknown } | null | undefined,
  userEmail: string | null | undefined,
): string | null {
  if (!profile || profile.email_verified !== true) return null;
  const profileEmail = canonicalAccountEmail(typeof profile.email === "string" ? profile.email : "");
  if (!profileEmail) return null;
  const accountEmail = canonicalAccountEmail(typeof userEmail === "string" ? userEmail : "");
  if (accountEmail && accountEmail !== profileEmail) return null;
  return profileEmail;
}
