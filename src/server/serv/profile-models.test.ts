import { describe, expect, it } from "vitest";
import { BASE_MODEL } from "./profiles";
import { resolveProfileBaseModel } from "./profile-models";

describe("resolveProfileBaseModel (t317 reversible Sonnet path)", () => {
  it("defaults to production BASE_MODEL (gpt-6.1-sol) with no override", () => {
    const r = resolveProfileBaseModel("scout_plan", { env: {} });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.baseId).toBe(BASE_MODEL);
    expect(r.source).toBe("base_default");
    expect(r.overrideActive).toBe(false);
  });

  it("SERV_PROFILE_MODEL_SCOUT_PLAN=claude-sonnet-5.5 beats global SERV_MODEL", () => {
    const r = resolveProfileBaseModel("scout_plan", {
      requested: BASE_MODEL,
      env: {
        SERV_MODEL: BASE_MODEL,
        SERV_PROFILE_MODEL_SCOUT_PLAN: "claude-sonnet-5.5",
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.baseId).toBe("claude-sonnet-5.5");
    expect(r.source).toBe("profile_env");
    expect(r.overrideActive).toBe(true);
    expect(r.honesty).toMatch(/Reversible profile override/);
  });

  it("caller requested wins when profile env unset (compare harness)", () => {
    const r = resolveProfileBaseModel("scout_plan", {
      requested: "claude-sonnet-5.5",
      env: {},
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.baseId).toBe("claude-sonnet-5.5");
    expect(r.source).toBe("caller_requested");
  });

  it("fails closed on unlisted model without ALLOW_UNLISTED", () => {
    const r = resolveProfileBaseModel("scout_plan", {
      env: { SERV_PROFILE_MODEL_SCOUT_PLAN: "gpt-6-luna-secret" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/Unsupported model/);
  });

  it("unsetting profile env restores BASE_MODEL — reversible", () => {
    const on = resolveProfileBaseModel("scout_plan", {
      env: { SERV_PROFILE_MODEL_SCOUT_PLAN: "claude-sonnet-5.5" },
    });
    const off = resolveProfileBaseModel("scout_plan", { env: {} });
    expect(on.ok).toBe(true);
    expect(off.ok).toBe(true);
    if (!on.ok || !off.ok) return;
    expect(on.baseId).toBe("claude-sonnet-5.5");
    expect(off.baseId).toBe(BASE_MODEL);
  });
});
