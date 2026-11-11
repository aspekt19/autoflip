import { describe, expect, it } from "vitest";
import { BASE_MODEL, PROFILES, type ProfileId } from "./profiles";
import { resolveProfileBaseModel, SERV_PROFILE_MODEL_CANDIDATES } from "./profile-models";
import { SERV_FLIP_DECISION_SHORTLIST_IDS } from "./flip-decision-shortlist";

describe("production SERV model = gpt-6.1-sol only", () => {
  it("BASE_MODEL is gpt-6.1-sol", () => {
    expect(BASE_MODEL).toBe("gpt-6.1-sol");
  });

  it("Flip production shortlist is gpt-6.1-sol only (no Sonnet-first order)", () => {
    expect(SERV_FLIP_DECISION_SHORTLIST_IDS).toEqual(["gpt-6.1-sol"]);
  });

  it("per-profile candidates are gpt-6.1-sol only (no Sonnet/Mini/prior-Sol first)", () => {
    for (const [id, list] of Object.entries(SERV_PROFILE_MODEL_CANDIDATES)) {
      expect(list, id).toEqual([BASE_MODEL]);
    }
  });

  it("every production profile resolves to gpt-6.1-sol unless SERV_MODEL overrides", () => {
    const ids = Object.keys(PROFILES) as ProfileId[];
    expect(ids.length).toBeGreaterThan(10);

    for (const id of ids) {
      const production = resolveProfileBaseModel(id, { env: {} });
      expect(production.ok, id).toBe(true);
      if (!production.ok) return;
      expect(production.baseId).toBe("gpt-6.1-sol");
      expect(production.source).toBe("base_default");
      expect(production.overrideActive).toBe(false);

      const viaServModel = resolveProfileBaseModel(id, {
        requested: "gpt-6.1-sol",
        env: {},
      });
      expect(viaServModel.ok, id).toBe(true);
      if (!viaServModel.ok) return;
      expect(viaServModel.baseId).toBe("gpt-6.1-sol");

      // Explicit SERV_MODEL-style override to another id requires ALLOW_UNLISTED.
      const blocked = resolveProfileBaseModel(id, {
        requested: "claude-sonnet-5.5",
        env: {},
      });
      expect(blocked.ok, id).toBe(false);

      const overridden = resolveProfileBaseModel(id, {
        requested: "claude-sonnet-5.5",
        env: { SERV_PROFILE_MODEL_ALLOW_UNLISTED: "1" },
      });
      expect(overridden.ok, id).toBe(true);
      if (!overridden.ok) return;
      expect(overridden.baseId).toBe("claude-sonnet-5.5");
      expect(overridden.source).toBe("caller_requested");
      expect(overridden.overrideActive).toBe(true);
    }
  });
});
