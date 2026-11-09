import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { headerAuthControl } from "@/components/header-auth";
import { assertBuyerSafeText } from "./find-buyer-copy";
import {
  ACCOUNT_AUTH_UNAVAILABLE,
  ACCOUNT_LOAD_FAILED_LABEL,
  ACCOUNT_LOADING_LABEL,
  ACCOUNT_RETRY_LABEL,
  ACCOUNT_SIGNED_OUT,
  BUY_IN_TEST_MODE_LABEL,
  CHECKOUT_LOCKED_LABEL,
  CHECKOUT_STARTING_LABEL,
  CREDITS_AUTH_OFF_BALANCE,
  CREDITS_AUTH_UNAVAILABLE,
  CREDITS_PACK_FAILED_LABEL,
  CREDITS_PACK_LOADING_LABEL,
  CREDITS_SIGN_IN_HINT,
  CREDITS_STRIPE_OFF,
  SIGN_IN_TO_BUY_LABEL,
  accountAuthConfigured,
  accountSignedOutMessage,
  canStartCreditCheckout,
  creditsPackButton,
  creditsPageModel,
  headerAuthConfiguredProp,
  headerBalancePresentation,
  readAccountFetch,
  reduceAccountLoad,
} from "./account-load";

const LOCKED = /Sign-in is not available yet|Sign-in is not configured|Checkout locked/;

function read(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), "utf8");
}

describe("account fetch tri-state", () => {
  it("treats a failed response as failed even when the body says auth is off", async () => {
    const result = await readAccountFetch(
      new Response(JSON.stringify({ auth: { configured: false }, authenticated: false }), { status: 503 }),
    );
    expect(result.phase).toBe("failed");
  });

  it("loads an explicit auth.configured flag and leaves a missing flag unknown", async () => {
    const off = await readAccountFetch(
      new Response(JSON.stringify({ auth: { configured: false }, credits: 0 }), { status: 200 }),
    );
    const on = await readAccountFetch(
      new Response(JSON.stringify({ auth: { configured: true }, authenticated: false, credits: 2 }), { status: 200 }),
    );
    const missing = await readAccountFetch(
      new Response(JSON.stringify({ authenticated: false, credits: 2 }), { status: 200 }),
    );
    expect(off.phase).toBe("loaded");
    expect(on.phase).toBe("loaded");
    expect(missing.phase).toBe("loaded");
    if (off.phase !== "loaded" || on.phase !== "loaded" || missing.phase !== "loaded") return;
    expect(accountAuthConfigured(off.body)).toBe(false);
    expect(accountAuthConfigured(on.body)).toBe(true);
    expect(accountAuthConfigured(missing.body)).toBe("unknown");
    expect(accountAuthConfigured(null)).toBe("unknown");
  });

  it("fails closed on a non-object payload", async () => {
    expect((await readAccountFetch(new Response("nope", { status: 200 }))).phase).toBe("failed");
    expect((await readAccountFetch(new Response("null", { status: 200 }))).phase).toBe("failed");
    expect((await readAccountFetch(new Response("[]", { status: 200 }))).phase).toBe("failed");
  });
});

describe("credits page copy", () => {
  it("stays neutral while the account request is loading", () => {
    const model = creditsPageModel({ phase: "loading", snap: null });
    expect(model.hint).toEqual({ kind: "loading", text: ACCOUNT_LOADING_LABEL });
    expect(ACCOUNT_LOADING_LABEL).toBe("Loading your account…");
    expect(model.showBalance).toBe(false);
    expect(model.authOffNote).toBeNull();
    expect(model.stripeOffNote).toBeNull();
    expect(JSON.stringify(model)).not.toMatch(LOCKED);

    const button = creditsPackButton({ phase: "loading", snap: null, pendingThis: false });
    expect(button.label).toBe(CREDITS_PACK_LOADING_LABEL);
    expect(button.label).not.toBe(CHECKOUT_LOCKED_LABEL);
    expect(button.disabled).toBe(true);
    expect(canStartCreditCheckout({ phase: "loading", snap: null })).toBe(false);
  });

  it("ignores a stale auth-off payload while loading or after failure", () => {
    const stale = {
      auth: { configured: false as const },
      authenticated: true,
      credits: 4,
      stripeConfigured: false,
    };
    for (const phase of ["loading", "failed"] as const) {
      const model = creditsPageModel({ phase, snap: stale });
      expect(model.showBalance).toBe(false);
      expect(model.authOffNote).toBeNull();
      expect(model.stripeOffNote).toBeNull();
      expect(JSON.stringify(model)).not.toMatch(LOCKED);
      const button = creditsPackButton({ phase, snap: stale, pendingThis: false });
      expect(button.disabled).toBe(true);
      expect(button.label).not.toMatch(LOCKED);
      expect(button.label).not.toBe("…");
      expect(canStartCreditCheckout({ phase, snap: stale })).toBe(false);
    }
    expect(headerAuthConfiguredProp("loading", stale)).toBeUndefined();
    expect(headerAuthConfiguredProp("failed", stale)).toBeUndefined();
  });

  it("asks for a retry when the account request fails and does not claim sign-in is off", () => {
    const model = creditsPageModel({ phase: "failed", snap: null });
    expect(model.hint).toEqual({
      kind: "failed",
      text: ACCOUNT_LOAD_FAILED_LABEL,
      retryLabel: ACCOUNT_RETRY_LABEL,
    });
    expect(model.hint.kind === "failed" && `${model.hint.text} ${model.hint.retryLabel}`).toBe(
      "Couldn't load your account. Retry",
    );
    expect(model.showBalance).toBe(false);
    expect(model.authOffNote).toBeNull();
    expect(JSON.stringify(model)).not.toMatch(LOCKED);

    const button = creditsPackButton({ phase: "failed", snap: null, pendingThis: false });
    expect(button.label).toBe(CREDITS_PACK_FAILED_LABEL);
    expect(button.label).toBe("Couldn't load");
    expect(button.label).not.toBe(CHECKOUT_LOCKED_LABEL);
    expect(button.label).not.toMatch(/…|\.\.\./);
    expect(button.disabled).toBe(true);
    expect(canStartCreditCheckout({ phase: "failed", snap: null })).toBe(false);
  });

  it("shows the locked checkout copy only when the payload says auth.configured is false", () => {
    const model = creditsPageModel({
      phase: "loaded",
      snap: { auth: { configured: false }, authenticated: false, credits: 0, stripeConfigured: true },
    });
    expect(model.hint).toEqual({ kind: "auth-off", text: CREDITS_AUTH_UNAVAILABLE });
    expect(model.showBalance).toBe(true);
    expect(model.balanceValue).toBe("0");
    expect(model.authOffNote).toBe(CREDITS_AUTH_OFF_BALANCE);
    expect(model.stripeOffNote).toBeNull();
    const button = creditsPackButton({
      phase: "loaded",
      snap: { auth: { configured: false }, authenticated: true },
      pendingThis: false,
    });
    expect(button.label).toBe(CHECKOUT_LOCKED_LABEL);
    expect(button.disabled).toBe(true);
  });

  it("keeps Sign in to buy when sign-in is configured and the visitor is signed out", () => {
    const snap = { auth: { configured: true }, authenticated: false, credits: 3, stripeConfigured: false };
    const model = creditsPageModel({ phase: "loaded", snap });
    expect(model.hint).toEqual({ kind: "sign-in", text: CREDITS_SIGN_IN_HINT });
    expect(model.authOffNote).toBeNull();
    expect(model.stripeOffNote).toMatch(/Stripe test keys are not configured/);
    expect(model.balanceValue).toBe("3");
    const button = creditsPackButton({ phase: "loaded", snap, pendingThis: false });
    expect(button.label).toBe(SIGN_IN_TO_BUY_LABEL);
    expect(button.disabled).toBe(true);
    expect(canStartCreditCheckout({ phase: "loaded", snap })).toBe(false);
    expect(JSON.stringify(model) + button.label).not.toMatch(LOCKED);
  });

  it("does not treat a loaded payload with no auth flag as sign-in turned off", () => {
    const snap = { authenticated: false, credits: 1 };
    const model = creditsPageModel({ phase: "loaded", snap });
    expect(model.hint.kind).toBe("sign-in");
    expect(model.authOffNote).toBeNull();
    expect(creditsPackButton({ phase: "loaded", snap, pendingThis: false }).label).toBe(SIGN_IN_TO_BUY_LABEL);
    expect(canStartCreditCheckout({ phase: "loaded", snap: { authenticated: true, credits: 2 } })).toBe(true);
  });

  it("enables test checkout for a signed-in visitor when auth is on", () => {
    const snap = { auth: { configured: true }, authenticated: true, demo: false, credits: 4 };
    const model = creditsPageModel({ phase: "loaded", snap });
    expect(model.hint.kind).toBe("signed-in");
    expect(model.balanceValue).toBe("4");
    expect(model.authOffNote).toBeNull();
    const idle = creditsPackButton({ phase: "loaded", snap, pendingThis: false });
    expect(idle.label).toBe(BUY_IN_TEST_MODE_LABEL);
    expect(idle.disabled).toBe(false);
    expect(canStartCreditCheckout({ phase: "loaded", snap })).toBe(true);
    const pending = creditsPackButton({ phase: "loaded", snap, pendingThis: true });
    expect(pending.label).toBe(CHECKOUT_STARTING_LABEL);
    expect(pending.disabled).toBe(true);
  });

  it("keeps the shared-demo hint ahead of the signed-out branches", () => {
    const model = creditsPageModel({
      phase: "loaded",
      snap: { demo: true, authenticated: false, auth: { configured: true }, credits: 1 },
    });
    expect(model.hint.kind).toBe("demo");
  });
});

describe("header balance and account signed-out copy", () => {
  it("uses a neutral loading label instead of Balance: …", () => {
    const view = headerBalancePresentation({ phase: "loading", credits: null });
    expect(view.kind).toBe("loading");
    expect(view.full).toBe(CREDITS_PACK_LOADING_LABEL);
    expect(view.short).toBe(CREDITS_PACK_LOADING_LABEL);
    expect(view.accessibleLabel).toBe(ACCOUNT_LOADING_LABEL);
    expect(view.full.length).toBeLessThan(ACCOUNT_LOADING_LABEL.length);
    expect(`${view.full} ${view.short} ${view.accessibleLabel}`).not.toMatch(/^Balance:/);
    expect(`${view.full} ${view.short} ${view.accessibleLabel}`).not.toMatch(LOCKED);
    expect(headerAuthConfiguredProp("loading", null)).toBeUndefined();
    expect(headerAuthControl({ authenticated: false, authConfigured: undefined }).availability).toBe("ready");
  });

  it("shows a retry after the header account request fails", () => {
    const view = headerBalancePresentation({ phase: "failed", credits: null });
    expect(view.kind).toBe("failed");
    expect(view.full).toBe(ACCOUNT_RETRY_LABEL);
    expect(view.short).toBe(ACCOUNT_RETRY_LABEL);
    expect(view.accessibleLabel).toBe(`${ACCOUNT_LOAD_FAILED_LABEL} ${ACCOUNT_RETRY_LABEL}`);
    expect(view.full).not.toMatch(/Balance:/);
    expect(view.short).not.toMatch(/…|\.\.\./);
    expect(`${view.full} ${view.short} ${view.accessibleLabel}`).not.toMatch(LOCKED);
    expect(headerAuthConfiguredProp("failed", { auth: { configured: false } })).toBeUndefined();
    expect(headerAuthControl({ authenticated: false, authConfigured: undefined }).availability).not.toBe("unavailable");
  });

  it("shows the credit count only after a loaded payload", () => {
    expect(headerBalancePresentation({ phase: "loaded", credits: 1 })).toEqual({
      kind: "balance",
      full: "1 report credit",
      short: "1 credit",
      accessibleLabel: "1 report credit",
    });
    expect(headerBalancePresentation({ phase: "loaded", credits: 2 })).toEqual({
      kind: "balance",
      full: "2 report credits",
      short: "2 credits",
      accessibleLabel: "2 report credits",
    });
    expect(headerBalancePresentation({ phase: "loaded", credits: null })).toEqual({
      kind: "balance",
      full: "Report credits",
      short: "Credits",
      accessibleLabel: "Report credits",
    });
    expect(headerAuthConfiguredProp("loaded", { auth: { configured: false } })).toBe(false);
    expect(headerAuthConfiguredProp("loaded", { auth: { configured: true } })).toBe(true);
    expect(headerAuthConfiguredProp("loaded", {})).toBeUndefined();
    expect(headerAuthControl({ authenticated: false, pathname: "/find", authConfigured: false }).availability).toBe(
      "unavailable",
    );
  });

  it("shows the account not-configured sentence only for an explicit false flag", () => {
    expect(accountSignedOutMessage(false)).toEqual({ kind: "auth-off", text: ACCOUNT_AUTH_UNAVAILABLE });
    expect(accountSignedOutMessage(true)).toEqual({ kind: "sign-in", text: ACCOUNT_SIGNED_OUT });
    expect(accountSignedOutMessage("unknown").kind).toBe("sign-in");
    expect(accountSignedOutMessage("unknown").text).not.toMatch(/not available yet/);
  });
});

describe("account load surfaces", () => {
  it("credits, header, and account stop coercing a missing auth flag to false", () => {
    const credits = read("src/app/credits/page.tsx");
    const header = read("src/components/Header.tsx");
    const account = read("src/components/AccountPanel.tsx");
    const domain = read("src/domain/account-load.ts");
    expect(domain).toMatch(/Loading your account…/);
    expect(domain).toMatch(/Couldn't load your account\./);
    expect(domain).toMatch(/Sign in to buy/);
    expect(credits).not.toMatch(/Boolean\(snap\?\.auth\?\.configured\)/);
    expect(header).not.toMatch(/Boolean\(body\.auth\?\.configured\)/);
    expect(account).not.toMatch(/Boolean\(body\.auth\?\.configured\)/);
    expect(credits).toMatch(/creditsPageModel/);
    expect(credits).toMatch(/creditsPackButton/);
    expect(credits).toMatch(/kind === "failed"/);
    expect(credits).toMatch(/canStartCreditCheckout/);
    expect(credits).toMatch(/disabled=\{button\.disabled\}/);
    expect(credits).not.toMatch(/Checkout locked|Sign-in is not configured|Sign-in is not available yet/);
    expect(header).toMatch(/headerBalancePresentation/);
    expect(header).toMatch(/kind === "failed"/);
    expect(header).toMatch(/type="button"/);
    expect(header).toMatch(/aria-label=\{balance\.accessibleLabel\}/);
    expect(header).toMatch(/accountLoad\.retry\(\)/);
    expect(header).not.toMatch(/Checkout locked|Sign-in is not configured|Sign-in is not available yet|Balance:/);
    expect(account).toMatch(/accountSignedOutMessage/);
    expect(account).toMatch(/phase === "failed"/);
    expect(account).toMatch(/ACCOUNT_RETRY_LABEL/);
    expect(account).not.toMatch(/Checkout locked|Sign-in is not configured|Sign-in is not available yet/);
    expect(account.indexOf("freeChecksRemainingFromAccount(body)")).toBeGreaterThan(account.indexOf('phase === "failed"'));
    expect(account.indexOf("accountSignedOutMessage(accountAuthConfigured")).toBeGreaterThan(
      account.indexOf('phase === "loaded"'),
    );
  });

  it("drops a failed payload before any screen can treat it as sign-in turned off", async () => {
    const loaded = {
      phase: "loaded" as const,
      body: { auth: { configured: true }, authenticated: true, credits: 4, stripeConfigured: true },
    };
    const kept = reduceAccountLoad(loaded, { type: "start", mode: "preserve-loaded" });
    expect(kept).toBe(loaded);
    const fetched = await readAccountFetch(
      new Response(JSON.stringify({ auth: { configured: false }, authenticated: false, credits: 0 }), { status: 503 }),
    );
    const dropped = reduceAccountLoad(kept, { type: "result", result: fetched });
    expect(dropped).toEqual({ phase: "failed", body: null });
    expect(creditsPageModel({ phase: dropped.phase, snap: dropped.body }).authOffNote).toBeNull();
    expect(creditsPackButton({ phase: dropped.phase, snap: dropped.body, pendingThis: false }).label).toBe(
      CREDITS_PACK_FAILED_LABEL,
    );
    expect(canStartCreditCheckout({ phase: dropped.phase, snap: dropped.body })).toBe(false);

    const replaced = reduceAccountLoad(loaded, { type: "start", mode: "replace" });
    expect(replaced).toEqual({ phase: "loading", body: null });
    expect(creditsPackButton({ phase: replaced.phase, snap: replaced.body, pendingThis: false }).disabled).toBe(true);
  });

  it("keeps buyer copy plain", () => {
    for (const text of [
      ACCOUNT_LOADING_LABEL,
      ACCOUNT_LOAD_FAILED_LABEL,
      ACCOUNT_RETRY_LABEL,
      CREDITS_AUTH_UNAVAILABLE,
      CREDITS_AUTH_OFF_BALANCE,
      CREDITS_SIGN_IN_HINT,
      CREDITS_STRIPE_OFF,
      CHECKOUT_LOCKED_LABEL,
      SIGN_IN_TO_BUY_LABEL,
      BUY_IN_TEST_MODE_LABEL,
      CHECKOUT_STARTING_LABEL,
      CREDITS_PACK_LOADING_LABEL,
      CREDITS_PACK_FAILED_LABEL,
      ACCOUNT_AUTH_UNAVAILABLE,
      ACCOUNT_SIGNED_OUT,
    ]) {
      expect(assertBuyerSafeText(text).ok, text).toBe(true);
    }
  });

  it("find does not coerce a missing account payload into auth-off copy", () => {
    const find = read("src/app/find/page.tsx");
    const flow = read("src/components/AssistantFlow.tsx");
    expect(find).not.toMatch(/auth\?\.configured/);
    expect(find).not.toMatch(/Checkout locked/);
    expect(find).not.toMatch(/Sign-in is not configured/);
    expect(flow).not.toMatch(/Boolean\([^)]*auth\?\.configured\)/);
    // Find search reports auth_unconfigured only from an explicit match error code.
    expect(flow).toMatch(/matchBody\.error === "auth_unconfigured"/);
  });
});
