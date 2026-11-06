import { describe, expect, it } from "vitest";
import {
  authIsConfigured,
  authStatusPayload,
  configuredAuthProviders,
  emailAuthConfigured,
  emailUsesTestInbox,
  googleAuthConfigured,
  isProductionRuntime,
  safeAuthCallbackUrl,
} from "./config";

describe("auth config fail-closed", () => {
  it("is unconfigured without secret or providers", () => {
    const env = {};
    expect(authIsConfigured(env)).toBe(false);
    expect(configuredAuthProviders(env)).toEqual([]);
  });

  it("needs AUTH_SECRET plus at least one provider", () => {
    expect(authIsConfigured({ AUTH_SECRET: "x" })).toBe(false);
    expect(
      authIsConfigured({
        AUTH_SECRET: "x",
        AUTH_GOOGLE_ID: "id",
        AUTH_GOOGLE_SECRET: "secret",
      }),
    ).toBe(true);
    expect(googleAuthConfigured({ AUTH_GOOGLE_ID: "id", AUTH_GOOGLE_SECRET: "secret" })).toBe(true);
    expect(emailAuthConfigured({ AUTH_EMAIL_MODE: "test", NODE_ENV: "development" })).toBe(true);
    expect(emailAuthConfigured({ EMAIL_SERVER: "smtp://x", EMAIL_FROM: "a@b.c" })).toBe(true);
  });

  it("prohibits AUTH_EMAIL_MODE=test in production", () => {
    expect(isProductionRuntime({ VERCEL_ENV: "production", NODE_ENV: "production" })).toBe(true);
    expect(emailUsesTestInbox({ AUTH_EMAIL_MODE: "test", VERCEL_ENV: "production", NODE_ENV: "production" })).toBe(
      false,
    );
    expect(emailAuthConfigured({ AUTH_EMAIL_MODE: "test", VERCEL_ENV: "production", NODE_ENV: "production" })).toBe(
      false,
    );
    expect(emailUsesTestInbox({ AUTH_EMAIL_MODE: "test", NODE_ENV: "development" })).toBe(true);
    expect(
      authStatusPayload({
        AUTH_SECRET: "x",
        AUTH_EMAIL_MODE: "test",
        VERCEL_ENV: "production",
        NODE_ENV: "production",
      }).testEmailModeBlockedInProduction,
    ).toBe(true);
  });

  it("allowlists only same-origin relative redirects", () => {
    expect(safeAuthCallbackUrl("/account")).toBe("/account");
    expect(safeAuthCallbackUrl("/credits?x=1")).toBe("/credits?x=1");
    expect(safeAuthCallbackUrl("//evil.com")).toBeNull();
    expect(safeAuthCallbackUrl("https://evil.com")).toBeNull();
    expect(safeAuthCallbackUrl("\\/evil")).toBeNull();
    expect(safeAuthCallbackUrl(null)).toBeNull();
  });

  it("reports provider status without secrets", () => {
    const status = authStatusPayload({
      AUTH_SECRET: "x",
      AUTH_EMAIL_MODE: "test",
      NODE_ENV: "development",
    });
    expect(status.configured).toBe(true);
    expect(status.email).toBe(true);
    expect(status.google).toBe(false);
    expect(status.emailMode).toBe("test");
  });
});
