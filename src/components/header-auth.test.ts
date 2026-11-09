import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FREE_VEHICLE_CHECKS_PER_MONTH } from "@/domain/free-check-quota";
import { assertBuyerSafeText } from "@/domain/find-buyer-copy";
import { HOME_ACCOUNT_LINE } from "./account-cta-copy";
import { emailInitial, headerAuthCallbackPath, headerAuthControl } from "./header-auth";

function read(rel: string): string {
  return readFileSync(path.join(process.cwd(), rel), "utf8");
}

describe("header auth button", () => {
  it("signed out links to /login and returns to /account", () => {
    const control = headerAuthControl({ authenticated: false, pathname: "/", authConfigured: true });
    expect(control.label).toBe("Sign in");
    expect(control.href).toBe("/login?callbackUrl=%2Faccount");
    expect(control.initial).toBeNull();
    expect(control.availability).toBe("ready");
    expect(control.href).not.toMatch(/\/api\/auth/);
  });

  it("signed out on a protected action returns to that page", () => {
    expect(headerAuthCallbackPath("/find")).toBe("/find");
    expect(headerAuthCallbackPath("/check")).toBe("/check");
    expect(headerAuthCallbackPath("/credits")).toBe("/credits");
    expect(headerAuthCallbackPath("/pricing")).toBe("/pricing");
    expect(headerAuthCallbackPath("/radar")).toBe("/radar");
    expect(headerAuthControl({ authenticated: false, pathname: "/find" }).href).toBe(
      "/login?callbackUrl=%2Ffind",
    );
    expect(headerAuthCallbackPath("/reports")).toBe("/account");
    expect(headerAuthCallbackPath("/login")).toBe("/account");
    expect(headerAuthCallbackPath("//evil.test")).toBe("/account");
  });

  it("signed in links to /account and can show an email initial", () => {
    const control = headerAuthControl({
      authenticated: true,
      email: "jane@example.com",
      pathname: "/find",
      authConfigured: true,
    });
    expect(control.label).toBe("Account");
    expect(control.href).toBe("/account");
    expect(control.initial).toBe("J");
    expect(control.availability).toBe("signed-in");
    expect(emailInitial("  9car@example.com")).toBe("9");
    expect(emailInitial(null)).toBeNull();
    expect(headerAuthControl({ authenticated: true, email: null }).initial).toBeNull();
  });

  it("auth not configured still opens /login instead of a provider URL", () => {
    const control = headerAuthControl({
      authenticated: false,
      pathname: "/credits",
      authConfigured: false,
    });
    expect(control.label).toBe("Sign in");
    expect(control.availability).toBe("unavailable");
    expect(control.href).toBe("/login?callbackUrl=%2Fcredits");
    expect(control.href.startsWith("/login?")).toBe(true);
  });

  it("header renders the control outside the collapsed nav and account page can sign out", () => {
    const header = read("src/components/Header.tsx");
    expect(header).toMatch(/headerAuthControl/);
    expect(header).toMatch(/className="nav-auth"/);
    expect(header).toMatch(/nav-go-short/);
    expect(header).not.toMatch(/\/api\/auth\/signin/);
    expect(header).toMatch(/useAccountLoad/);
    expect(read("src/components/use-account-load.ts")).toMatch(/fetch\(["']\/api\/account["']/);
    const account = read("src/components/AccountPanel.tsx");
    expect(account).toMatch(/Sign out/);
    expect(account).toMatch(/signOutAction/);
    const css = read("src/app/globals.css");
    expect(css).toMatch(/\.nav-auth\b/);
    expect(css).not.toMatch(/nav a:not\(\.nav-go, \.nav-auth\)/);
    expect(css).toMatch(/nav:not\(\.nav-open\) \.nav-go \{ display: none; \}/);
  });
});

describe("home account line", () => {
  it("states the real free-check allotment and the Find billing phrase", () => {
    expect(FREE_VEHICLE_CHECKS_PER_MONTH).toBe(3);
    expect(HOME_ACCOUNT_LINE).toContain(
      `${FREE_VEHICLE_CHECKS_PER_MONTH} free VIN or your own listing URL checks per verified account each UTC month`,
    );
    expect(HOME_ACCOUNT_LINE).toMatch(/credit-priced search when billing is enabled/);
    expect(HOME_ACCOUNT_LINE).toMatch(/free account/);
    expect(assertBuyerSafeText(HOME_ACCOUNT_LINE).ok).toBe(true);
    expect(read("src/components/HomeStage.tsx")).toMatch(/HOME_ACCOUNT_LINE/);
  });
});

describe("login unavailable state and email gating", () => {
  it("uses plain Sign-in is not available yet copy and hides email unless Firebase config is on", () => {
    const page = read("src/app/login/page.tsx");
    expect(page).toMatch(/Sign-in is not available yet/);
    expect(page).not.toMatch(/AUTH_SECRET|AUTH_GOOGLE_|EMAIL_SERVER|EMAIL_FROM|AUTH_EMAIL_MODE/);
    expect(page).toMatch(/email=\{auth\.email\}/);
    expect(page).toMatch(/firebase=\{firebase\}/);
    const form = read("src/components/LoginForm.tsx");
    expect(form).toMatch(/Continue with Google/);
    expect(form).toMatch(/Email me a sign-in link/);
    expect(form).toMatch(/sendSignInLinkToEmail/);
    expect(form).toMatch(/handleCodeInApp:\s*true/);
    expect(form).toMatch(/EMAIL_LINK_FINISH_PATH/);
    expect(form).toMatch(/EMAIL_LINK_STORAGE_KEY/);
    expect(form).toMatch(/Check your inbox \(and spam\) for a sign-in link/);
    expect(form).toMatch(/showEmail/);
    expect(form).toMatch(/safeAuthCallbackUrl/);
    expect(form).not.toMatch(/function safeCallback/);
    const finish = read("src/app/login/finish/page.tsx");
    expect(finish).toMatch(/Sign-in is not available yet/);
    const finishClient = read("src/components/EmailLinkFinish.tsx");
    expect(finishClient).toMatch(/isSignInWithEmailLink/);
    expect(finishClient).toMatch(/signInWithEmailLink/);
    expect(finishClient).toMatch(/signInWithEmailLinkToken/);
    expect(finishClient).toMatch(/EMAIL_LINK_STORAGE_KEY/);
    expect(finishClient).toMatch(/localStorage\.removeItem\(EMAIL_LINK_STORAGE_KEY\)/);
    expect(finishClient).toMatch(/callbackUrl/);
    const checkPage = read("src/app/check/page.tsx");
    expect(checkPage).toMatch(/3 free VIN or your own listing URL checks/);
    expect(checkPage).not.toMatch(/Full report: costs 1 report credit/);
    const auth = read("src/auth.ts");
    expect(auth).toMatch(/strategy:\s*"jwt"/);
    expect(auth).toMatch(/id:\s*"email-link"/);
    expect(auth).not.toMatch(/nodemailer|EMAIL_SERVER|AUTH_EMAIL_MODE/);
  });
});
