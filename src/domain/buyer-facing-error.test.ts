import { describe, expect, it } from "vitest";
import { buyerFacingFailure } from "./buyer-facing-error";

describe("buyerFacingFailure", () => {
  it("hides storage and auth internals", () => {
    expect(buyerFacingFailure("money_store_unconfigured", "Persistent Upstash KV is required.", "fallback")).toBe(
      "Sign-in is not available yet.",
    );
    expect(buyerFacingFailure("auth_unconfigured", "AUTH_SECRET missing", "fallback")).toBe(
      "Sign-in is not available yet.",
    );
    expect(buyerFacingFailure(undefined, "Browser claims use the af_uid cookie only.", "Claim failed.")).toBe(
      "Claim failed.",
    );
    expect(buyerFacingFailure(undefined, "Checkout was canceled.", "fallback")).toBe("Checkout was canceled.");
  });
});
