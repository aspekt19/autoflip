import { describe, expect, it } from "vitest";
import { BASE_MODEL } from "./profiles";
import { resolveProfileBaseModel } from "./profile-models";

describe("resolveProfileBaseModel (production gpt-6.1-sol)", () => {
  it("defaults to production BASE_MODEL (gpt-6.1-sol) with no override", () => {
    const r = resolveProfileBaseModel("find_plan", { env: {} });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.baseId).toBe(BASE_MODEL);
    expect(r.source).toBe("base_default");
    expect(r.overrideActive).toBe(false);
  });

  it("SERV_PROFILE_MODEL_FIND_PLAN non-BASE_MODEL fails closed without ALLOW_UNLISTED", () => {
    const r = resolveProfileBaseModel("find_plan", {
      requested: BASE_MODEL,
      env: {
        SERV_MODEL: BASE_MODEL,
        SERV_PROFILE_MODEL_FIND_PLAN: "claude-sonnet-5.5",
      },
    });
    expect(r.ok).toBe(false);
  });

  it("caller requested wins when profile env unset (compare harness + ALLOW_UNLISTED)", () => {
    const r = resolveProfileBaseModel("find_plan", {
      requested: "claude-sonnet-5.5",
      env: { SERV_PROFILE_MODEL_ALLOW_UNLISTED: "1" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.baseId).toBe("claude-sonnet-5.5");
    expect(r.source).toBe("caller_requested");
  });

  it("fails closed on unlisted model without ALLOW_UNLISTED", () => {
    const r = resolveProfileBaseModel("find_plan", {
      env: { SERV_PROFILE_MODEL_FIND_PLAN: "gpt-6-luna-secret" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/Unsupported model/);
  });

  it("unsetting profile env restores BASE_MODEL — reversible", () => {
    const on = resolveProfileBaseModel("find_plan", {
      env: {
        SERV_PROFILE_MODEL_FIND_PLAN: "claude-sonnet-5.5",
        SERV_PROFILE_MODEL_ALLOW_UNLISTED: "1",
      },
    });
    const off = resolveProfileBaseModel("find_plan", { env: {} });
    expect(on.ok).toBe(true);
    expect(off.ok).toBe(true);
    if (!on.ok || !off.ok) return;
    expect(on.baseId).toBe("claude-sonnet-5.5");
    expect(off.baseId).toBe(BASE_MODEL);
  });
});
