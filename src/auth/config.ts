/**
 * Auth readiness and redirect allowlisting.
 * Paid checkout fails closed when auth is not fully configured.
 */

export type AuthProviderKind = "google" | "email";

export type AuthEnv = Record<string, string | undefined>;

/** Production (and Vercel production) — never allow AUTH_EMAIL_MODE=test here. */
export function isProductionRuntime(env: AuthEnv = process.env): boolean {
  if (env.VERCEL_ENV === "production") return true;
  if (env.NODE_ENV === "production" && env.VERCEL_ENV !== "preview" && env.VERCEL_ENV !== "development") {
    return true;
  }
  return false;
}

export function authSecretConfigured(env: AuthEnv = process.env): boolean {
  return Boolean(env.AUTH_SECRET?.trim());
}

export function googleAuthConfigured(env: AuthEnv = process.env): boolean {
  return Boolean(env.AUTH_GOOGLE_ID?.trim() && env.AUTH_GOOGLE_SECRET?.trim());
}

/**
 * Test inbox is for local/CI only. Explicitly unavailable in production even if
 * AUTH_EMAIL_MODE=test is mistakenly set on the host.
 */
export function emailUsesTestInbox(env: AuthEnv = process.env): boolean {
  if (isProductionRuntime(env)) return false;
  if (env.AUTH_EMAIL_MODE?.trim() === "test") return true;
  return env.NODE_ENV === "test";
}

/** Test inbox stubs magic links into KV; production requires real SMTP. */
export function emailAuthConfigured(env: AuthEnv = process.env): boolean {
  if (emailUsesTestInbox(env)) return true;
  // Production (or any non-test mode) needs real SMTP — never AUTH_EMAIL_MODE=test.
  if (env.AUTH_EMAIL_MODE?.trim() === "test" && isProductionRuntime(env)) return false;
  return Boolean(env.EMAIL_SERVER?.trim() && env.EMAIL_FROM?.trim());
}

export function configuredAuthProviders(env: AuthEnv = process.env): AuthProviderKind[] {
  const out: AuthProviderKind[] = [];
  if (googleAuthConfigured(env)) out.push("google");
  if (emailAuthConfigured(env)) out.push("email");
  return out;
}

/** True only when secret + at least one sign-in provider are present. */
export function authIsConfigured(env: AuthEnv = process.env): boolean {
  return authSecretConfigured(env) && configuredAuthProviders(env).length > 0;
}

/**
 * Only same-origin relative paths are allowed as post-login redirects.
 * Rejects protocol-relative, absolute, and backslash tricks.
 */
export function safeAuthCallbackUrl(value: string | null | undefined, maxLen = 200): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//") || trimmed.includes("://")) return null;
  if (trimmed.includes("\\") || trimmed.includes("\0")) return null;
  if (trimmed.length > maxLen) return null;
  return trimmed;
}

export function authStatusPayload(env: AuthEnv = process.env) {
  const providers = configuredAuthProviders(env);
  const testRequested = env.AUTH_EMAIL_MODE?.trim() === "test";
  return {
    configured: authIsConfigured(env),
    secretConfigured: authSecretConfigured(env),
    providers,
    google: providers.includes("google"),
    email: providers.includes("email"),
    emailMode: emailUsesTestInbox(env) ? ("test" as const) : ("smtp" as const),
    testEmailModeBlockedInProduction: testRequested && isProductionRuntime(env),
  };
}
