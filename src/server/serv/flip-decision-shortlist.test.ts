import { describe, expect, it } from "vitest";
import {
  SERV_FLIP_DECISION_SHORTLIST,
  SERV_FLIP_DECISION_SHORTLIST_IDS,
  SERV_FLIP_EXCLUDED_FROM_PAID,
  SERV_FLIP_SUPERSEDED_AUTOMATIC_NEXT,
  isFlipDecisionShortlistId,
} from "./flip-decision-shortlist";
import { resolveServCompareModelIds, listServFlipDecisionShortlist } from "./model-catalog";
import { BASE_MODEL } from "./profiles";
import { resolveProfileBaseModel } from "./profile-models";

describe("Flip decision shortlist (t321 Fable excluded)", () => {
  it("uses Sonnet → gpt-5.6-sol only (Fable excluded from paid)", () => {
    expect(SERV_FLIP_DECISION_SHORTLIST_IDS).toEqual(["claude-sonnet-5.5", "gpt-5.6-sol"]);
    expect(SERV_FLIP_DECISION_SHORTLIST.map((e) => e.flipOrder)).toEqual([1, 2]);
    expect(SERV_FLIP_DECISION_SHORTLIST[1]!.inputPerMDisplay).toBe("$5.25");
    expect([...SERV_FLIP_EXCLUDED_FROM_PAID]).toEqual(["claude-fable-5"]);
    expect(isFlipDecisionShortlistId("claude-fable-5")).toBe(false);
    expect([...SERV_FLIP_SUPERSEDED_AUTOMATIC_NEXT]).toEqual(["gpt-6.1-sol", "claude-opus-5.5"]);
  });

  it("resolves shortlist without ALLOW_UNLISTED", () => {
    const r = resolveServCompareModelIds(SERV_FLIP_DECISION_SHORTLIST_IDS.join(","));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.models.map((m) => m.id)).toEqual([...SERV_FLIP_DECISION_SHORTLIST_IDS]);
    expect(r.models.every((m) => m.kind === "flip_decision_shortlist")).toBe(true);
  });

  it("profile override accepts gpt-5.6-sol and sonnet first-class; Fable not shortlist", () => {
    for (const id of ["gpt-5.6-sol", "claude-sonnet-5.5"] as const) {
      expect(isFlipDecisionShortlistId(id)).toBe(true);
      const r = resolveProfileBaseModel("scout_plan", {
        env: { SERV_PROFILE_MODEL_SCOUT_PLAN: id },
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.baseId).toBe(id);
      // Shared BASE_MODEL is gpt-6.1-sol — gpt-5.6-sol / Sonnet env pins are overrides.
      expect(r.overrideActive).toBe(id !== BASE_MODEL);
    }
    const findProfile = resolveProfileBaseModel("find_next_check", {
      env: { SERV_PROFILE_MODEL_FIND_NEXT_CHECK: "gpt-5.6-sol" },
    });
    expect(findProfile.ok).toBe(true);
    if (!findProfile.ok) return;
    expect(findProfile.baseId).toBe("gpt-5.6-sol");
    expect(findProfile.overrideActive).toBe(true);
    const fableBlocked = resolveProfileBaseModel("find_next_check", {
      env: { SERV_PROFILE_MODEL_FIND_NEXT_CHECK: "claude-fable-5" },
    });
    expect(fableBlocked.ok).toBe(false);
  });

  it("listServFlipDecisionShortlist matches shortlist length", () => {
    expect(listServFlipDecisionShortlist()).toHaveLength(2);
  });
});
