/**
 * Client view of GET /api/account.
 * Loading and failure are not the same as auth.configured === false.
 */

export const ACCOUNT_LOADING_LABEL = "Loading your account…";
export const ACCOUNT_LOAD_FAILED_LABEL = "Couldn't load your account.";
export const ACCOUNT_RETRY_LABEL = "Retry";

export const CREDITS_AUTH_UNAVAILABLE =
  "Sign-in is not available yet. Paid checkout and free monthly vehicle checks stay locked until sign-in is turned on.";
export const CREDITS_AUTH_OFF_BALANCE = "Sign-in is not configured, so paid checkout stays locked.";
export const CREDITS_SIGN_IN_HINT =
  "Sign in before buying so credits stay with your account after cookies are cleared.";
export const CREDITS_STRIPE_OFF = "Stripe test keys are not configured, so checkout cannot start.";

export const CHECKOUT_LOCKED_LABEL = "Checkout locked";
export const SIGN_IN_TO_BUY_LABEL = "Sign in to buy";
export const BUY_IN_TEST_MODE_LABEL = "Buy in test mode";
export const CHECKOUT_STARTING_LABEL = "Starting…";
export const CREDITS_PACK_LOADING_LABEL = "Loading…";
/** Failed checkout control. Not an ellipsis, and not the locked-checkout label. */
export const CREDITS_PACK_FAILED_LABEL = "Couldn't load";

export const ACCOUNT_AUTH_UNAVAILABLE =
  "Sign-in is not available yet. Vehicle checks, Find search, and buying credits stay locked.";
export const ACCOUNT_SIGNED_OUT =
  "You are browsing without an account. Sign in so checks and purchases stay with you after cookies are cleared.";

export type AccountLoadPhase = "loading" | "failed" | "loaded";

export type AccountSnapshot = {
  credits?: number;
  stripeConfigured?: boolean;
  demo?: boolean;
  authenticated?: boolean;
  email?: string | null;
  emailVerified?: boolean;
  auth?: { configured?: boolean };
  browserClaimable?: boolean;
  freeChecks?: { remaining?: number; limit?: number; resetsLabel?: string } | null;
};

export type AccountAuthFlag = true | false | "unknown";

/** True or false only when the payload says so. Missing is unknown, not off. */
export function accountAuthConfigured(
  body: { auth?: { configured?: boolean } } | null | undefined,
): AccountAuthFlag {
  if (body?.auth?.configured === true) return true;
  if (body?.auth?.configured === false) return false;
  return "unknown";
}

export async function readAccountFetch(
  response: Response,
): Promise<{ phase: "failed" } | { phase: "loaded"; body: AccountSnapshot }> {
  if (!response.ok) return { phase: "failed" };
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { phase: "failed" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { phase: "failed" };
  return { phase: "loaded", body: parsed as AccountSnapshot };
}

export type AccountLoadState = {
  phase: AccountLoadPhase;
  body: AccountSnapshot | null;
};

/**
 * A failed read drops any previous payload.
 * Loading and failure must not keep auth.configured === false around to render.
 * A refresh that already loaded keeps that payload only until the next result.
 */
export function reduceAccountLoad(
  prev: AccountLoadState,
  event:
    | { type: "start"; mode: "replace" | "preserve-loaded" }
    | { type: "result"; result: { phase: "failed" } | { phase: "loaded"; body: AccountSnapshot } },
): AccountLoadState {
  if (event.type === "start") {
    if (event.mode === "preserve-loaded" && prev.phase === "loaded") return prev;
    if (prev.phase === "loading" && prev.body === null) return prev;
    return { phase: "loading", body: null };
  }
  if (event.result.phase === "failed") return { phase: "failed", body: null };
  return { phase: "loaded", body: event.result.body };
}

export type CreditsHint =
  | { kind: "loading"; text: string }
  | { kind: "failed"; text: string; retryLabel: string }
  | { kind: "demo" }
  | { kind: "signed-in" }
  | { kind: "sign-in"; text: string }
  | { kind: "auth-off"; text: string };

export type CreditsPageModel = {
  hint: CreditsHint;
  showBalance: boolean;
  balanceValue: string;
  stripeOffNote: string | null;
  authOffNote: string | null;
};

export function creditsPageModel(input: {
  phase: AccountLoadPhase;
  snap: AccountSnapshot | null;
}): CreditsPageModel {
  if (input.phase === "loading") {
    return {
      hint: { kind: "loading", text: ACCOUNT_LOADING_LABEL },
      showBalance: false,
      balanceValue: "…",
      stripeOffNote: null,
      authOffNote: null,
    };
  }
  if (input.phase === "failed") {
    return {
      hint: { kind: "failed", text: ACCOUNT_LOAD_FAILED_LABEL, retryLabel: ACCOUNT_RETRY_LABEL },
      showBalance: false,
      balanceValue: "…",
      stripeOffNote: null,
      authOffNote: null,
    };
  }
  const snap = input.snap;
  const auth = accountAuthConfigured(snap);
  const hint: CreditsHint = snap?.demo === true
    ? { kind: "demo" }
    : snap?.authenticated === true
      ? { kind: "signed-in" }
      : auth === false
        ? { kind: "auth-off", text: CREDITS_AUTH_UNAVAILABLE }
        : { kind: "sign-in", text: CREDITS_SIGN_IN_HINT };
  const credits = snap?.credits;
  return {
    hint,
    showBalance: true,
    balanceValue: typeof credits === "number" && Number.isFinite(credits) ? String(credits) : "…",
    stripeOffNote: snap?.stripeConfigured === false ? CREDITS_STRIPE_OFF : null,
    authOffNote: auth === false ? CREDITS_AUTH_OFF_BALANCE : null,
  };
}

export function creditsPackButton(input: {
  phase: AccountLoadPhase;
  snap: AccountSnapshot | null;
  pendingThis: boolean;
}): { label: string; disabled: boolean } {
  if (input.pendingThis) return { label: CHECKOUT_STARTING_LABEL, disabled: true };
  if (input.phase === "loading") return { label: CREDITS_PACK_LOADING_LABEL, disabled: true };
  if (input.phase !== "loaded") return { label: CREDITS_PACK_FAILED_LABEL, disabled: true };
  if (accountAuthConfigured(input.snap) === false) return { label: CHECKOUT_LOCKED_LABEL, disabled: true };
  if (input.snap?.authenticated === true) return { label: BUY_IN_TEST_MODE_LABEL, disabled: false };
  return { label: SIGN_IN_TO_BUY_LABEL, disabled: true };
}

/** True only when the pack button would actually start checkout. */
export function canStartCreditCheckout(input: {
  phase: AccountLoadPhase;
  snap: AccountSnapshot | null;
}): boolean {
  return creditsPackButton({ ...input, pendingThis: false }).disabled === false;
}

export function headerBalancePresentation(input: {
  phase: AccountLoadPhase;
  credits: number | null;
  /** Credits reserved for an in-flight charge (not a lock-only inflight key). */
  held?: number | null;
}): { kind: "loading" | "failed" | "balance"; full: string; short: string; accessibleLabel: string } {
  // Visible chip stays short. The header row is nowrap, and a full sentence
  // crowds the Sign in control. The accessible name keeps the full sentence.
  if (input.phase === "loading") {
    return {
      kind: "loading",
      full: CREDITS_PACK_LOADING_LABEL,
      short: CREDITS_PACK_LOADING_LABEL,
      accessibleLabel: ACCOUNT_LOADING_LABEL,
    };
  }
  if (input.phase === "failed") {
    return {
      kind: "failed",
      full: ACCOUNT_RETRY_LABEL,
      short: ACCOUNT_RETRY_LABEL,
      accessibleLabel: `${ACCOUNT_LOAD_FAILED_LABEL} ${ACCOUNT_RETRY_LABEL}`,
    };
  }
  if (input.credits === null) {
    return { kind: "balance", full: "Report credits", short: "Credits", accessibleLabel: "Report credits" };
  }
  const held = typeof input.held === "number" && input.held > 0 ? Math.floor(input.held) : 0;
  const available = Math.max(0, input.credits - held);
  const noun = available === 1 ? "credit" : "credits";
  if (held > 0) {
    const full = `${available} available (${held} held)`;
    return {
      kind: "balance",
      full,
      short: `${available} avail`,
      accessibleLabel: `${available} report ${noun} available, ${held} held`,
    };
  }
  const full = `${input.credits} report ${noun}`;
  return { kind: "balance", full, short: `${input.credits} ${noun}`, accessibleLabel: full };
}

/** False only after a loaded payload explicitly says providers are off. */
export function headerAuthConfiguredProp(
  phase: AccountLoadPhase,
  body: { auth?: { configured?: boolean } } | null,
): boolean | undefined {
  if (phase !== "loaded") return undefined;
  const flag = accountAuthConfigured(body);
  if (flag === "unknown") return undefined;
  return flag;
}

export function accountSignedOutMessage(flag: AccountAuthFlag): { kind: "auth-off" | "sign-in"; text: string } {
  if (flag === false) return { kind: "auth-off", text: ACCOUNT_AUTH_UNAVAILABLE };
  return { kind: "sign-in", text: ACCOUNT_SIGNED_OUT };
}
