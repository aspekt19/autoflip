/**
 * Header account control.
 * Signed out always goes to our /login page (including when providers are off),
 * never straight to a provider URL that would 500 without AUTH_SECRET.
 */

export const HEADER_PROTECTED_ACTION_PREFIXES = ["/find", "/check", "/credits", "/pricing", "/radar"] as const;

export type HeaderAuthAvailability = "ready" | "unavailable" | "signed-in";

export type HeaderAuthControl = {
  href: string;
  label: "Sign in" | "Account";
  /** First letter of the email, for a small mark next to Account. */
  initial: string | null;
  availability: HeaderAuthAvailability;
};

export function emailInitial(email: string | null | undefined): string | null {
  if (!email) return null;
  const local = email.trim().split("@")[0] ?? "";
  const match = local.match(/[A-Za-z0-9]/);
  return match ? match[0]!.toUpperCase() : null;
}

/** After login, return to a protected action page; otherwise land on /account. */
export function headerAuthCallbackPath(pathname: string | null | undefined): string {
  if (!pathname) return "/account";
  const path = pathname.split("?")[0]?.split("#")[0] ?? "";
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return "/account";
  if (path === "/login" || path.startsWith("/login/")) return "/account";
  const protectedAction = HEADER_PROTECTED_ACTION_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
  return protectedAction ? path : "/account";
}

export function headerAuthControl(input: {
  authenticated: boolean;
  email?: string | null;
  pathname?: string | null;
  /** False only after /api/account says providers are off. Unknown still links to /login. */
  authConfigured?: boolean;
}): HeaderAuthControl {
  if (input.authenticated) {
    return {
      href: "/account",
      label: "Account",
      initial: emailInitial(input.email),
      availability: "signed-in",
    };
  }
  const callback = headerAuthCallbackPath(input.pathname);
  return {
    href: `/login?callbackUrl=${encodeURIComponent(callback)}`,
    label: "Sign in",
    initial: null,
    availability: input.authConfigured === false ? "unavailable" : "ready",
  };
}
