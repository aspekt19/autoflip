import { describe, expect, it } from "vitest";
import {
  authIsConfigured,
  authStatusPayload,
  configuredAuthProviders,
  emailAuthConfigured,
  firebasePublicConfig,
  googleAuthConfigured,
  safeAuthCallbackUrl,
} from "./config";

const FIREBASE = {
  NEXT_PUBLIC_FIREBASE_API_KEY: "public-key",
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "lemonless.firebaseapp.com",
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: "lemonless",
  NEXT_PUBLIC_FIREBASE_APP_ID: "1:1:web:abc",
};

describe("auth config fail-closed", () => {
  it("is unconfigured without secret or providers", () => {
    const env = {};
    expect(authIsConfigured(env)).toBe(false);
    expect(configuredAuthProviders(env)).toEqual([]);
    expect(firebasePublicConfig(env)).toBeNull();
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
    expect(emailAuthConfigured({ EMAIL_SERVER: "smtp://x", EMAIL_FROM: "a@b.c" })).toBe(false);
    expect(emailAuthConfigured(FIREBASE)).toBe(true);
  });

  it("shows email only when every public Firebase value is set", () => {
    expect(emailAuthConfigured({})).toBe(false);
    expect(emailAuthConfigured({ ...FIREBASE, NEXT_PUBLIC_FIREBASE_PROJECT_ID: "" })).toBe(false);
    expect(emailAuthConfigured({ ...FIREBASE, NEXT_PUBLIC_FIREBASE_API_KEY: "  " })).toBe(false);
    expect(firebasePublicConfig(FIREBASE)?.projectId).toBe("lemonless");
    const status = authStatusPayload({ AUTH_SECRET: "x", ...FIREBASE });
    expect(status.email).toBe(true);
    expect(status.google).toBe(false);
    expect(status.configured).toBe(true);
    expect(status).not.toHaveProperty("emailMode");
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
      AUTH_GOOGLE_ID: "id",
      AUTH_GOOGLE_SECRET: "secret",
    });
    expect(status.configured).toBe(true);
    expect(status.email).toBe(false);
    expect(status.google).toBe(true);
    expect(JSON.stringify(status)).not.toContain("AUTH_GOOGLE_SECRET");
  });
});
