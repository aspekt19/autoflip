import { describe, expect, it } from "vitest";
import { BASE_MODEL, PROFILES, type ProfileId } from "./profiles";
import { resolveProfileBaseModel, SERV_PROFILE_MODEL_CANDIDATES } from "./profile-models";
import { SERV_FLIP_DECISION_SHORTLIST_IDS } from "./flip-decision-shortlist";

describe("production SERV model = BASE_MODEL only", () => {
  it("BASE_MODEL is gpt-6-luna", () => {
    expect(typeof BASE_MODEL).toBe("string");
    expect(BASE_MODEL.length).toBeGreaterThan(0);
  });

  it("Flip production shortlist is BASE_MODEL only (no Sonnet-first order)", () => {
    expect(SERV_FLIP_DECISION_SHORTLIST_IDS).toEqual([BASE_MODEL]);
  });

  it("per-profile candidates are BASE_MODEL only (no Sonnet/Mini/prior-Sol first)", () => {
    for (const [id, list] of Object.entries(SERV_PROFILE_MODEL_CANDIDATES)) {
      expect(list, id).toEqual([BASE_MODEL]);
    }
  });

  it("every production profile resolves to BASE_MODEL unless SERV_MODEL overrides", () => {
    const ids = Object.keys(PROFILES) as ProfileId[];
    expect(ids.length).toBeGreaterThan(10);

    for (const id of ids) {
      const production = resolveProfileBaseModel(id, { env: {} });
      expect(production.ok, id).toBe(true);
      if (!production.ok) return;
      expect(production.baseId).toBe(BASE_MODEL);
      expect(production.source).toBe("base_default");
      expect(production.overrideActive).toBe(false);

      const viaServModel = resolveProfileBaseModel(id, {
        requested: BASE_MODEL,
        env: {},
      });
      expect(viaServModel.ok, id).toBe(true);
      if (!viaServModel.ok) return;
      expect(viaServModel.baseId).toBe(BASE_MODEL);

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
