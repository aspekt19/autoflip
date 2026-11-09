"use server";

import { signIn, signOut } from "@/auth";
import { authIsConfigured, emailAuthConfigured, safeAuthCallbackUrl } from "@/auth/config";

export async function signInWithGoogle(callbackUrl?: string) {
  if (!authIsConfigured()) {
    return { error: "auth_unconfigured" as const };
  }
  const target = safeAuthCallbackUrl(callbackUrl) ?? "/account";
  await signIn("google", { redirectTo: target });
}

/** Exchange a verified Firebase ID token for a Lemonless session. Lands on /account. */
export async function signInWithEmailLinkToken(idToken: string) {
  if (!emailAuthConfigured() || !authIsConfigured()) {
    return { error: "auth_unconfigured" as const };
  }
  const token = idToken.trim();
  if (!token) return { error: "email_link_failed" as const };
  try {
    await signIn("email-link", { idToken: token, redirectTo: "/account" });
  } catch (error) {
    if (isNextRedirect(error)) throw error;
    return { error: "email_link_failed" as const };
  }
}

export async function signOutAction() {
  await signOut({ redirectTo: "/" });
}

function isNextRedirect(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const digest = (error as { digest?: string }).digest;
  if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT")) return true;
  return error instanceof Error && error.message.includes("NEXT_REDIRECT");
}
