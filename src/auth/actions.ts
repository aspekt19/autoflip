"use server";

import { signIn, signOut } from "@/auth";
import { authIsConfigured, safeAuthCallbackUrl } from "@/auth/config";

export async function signInWithGoogle(callbackUrl?: string) {
  if (!authIsConfigured()) {
    return { error: "auth_unconfigured" as const };
  }
  const target = safeAuthCallbackUrl(callbackUrl) ?? "/account";
  await signIn("google", { redirectTo: target });
}

export async function signInWithEmail(formData: FormData) {
  if (!authIsConfigured()) {
    return { error: "auth_unconfigured" as const };
  }
  const email = String(formData.get("email") ?? "").trim();
  const callbackUrl = safeAuthCallbackUrl(String(formData.get("callbackUrl") ?? "")) ?? "/account";
  if (!email || !email.includes("@")) {
    return { error: "invalid_email" as const };
  }
  try {
    await signIn("email", { email, redirectTo: callbackUrl, redirect: false });
    return { ok: true as const };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("email_rate_limited")) return { error: "email_rate_limited" as const };
    // Auth.js may throw NEXT_REDIRECT even with redirect:false in some versions — treat as sent.
    if (message.includes("NEXT_REDIRECT") || (error as { digest?: string })?.digest?.startsWith("NEXT_REDIRECT")) {
      return { ok: true as const };
    }
    return { error: "email_send_failed" as const };
  }
}

export async function signOutAction() {
  await signOut({ redirectTo: "/" });
}
