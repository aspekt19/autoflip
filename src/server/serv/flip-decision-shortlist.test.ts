import { describe, expect, it } from "vitest";
import {
  SERV_FLIP_DECISION_SHORTLIST,
  SERV_FLIP_DECISION_SHORTLIST_IDS,
  SERV_FLIP_SUPERSEDED_AUTOMATIC_NEXT,
  isFlipDecisionShortlistId,
} from "./flip-decision-shortlist";
import { resolveServCompareModelIds, listServFlipDecisionShortlist } from "./model-catalog";
import { resolveProfileBaseModel } from "./profile-models";

describe("Flip t319 decision shortlist (corrected console CSV IDs)", () => {
  it("uses Sonnet → gpt-5.6-sol → claude-fable-5 (not gpt-6.1-sol/opus automatic)", () => {
    expect(SERV_FLIP_DECISION_SHORTLIST_IDS).toEqual([
      "claude-sonnet-5.5",
      "gpt-5.6-sol",
      "claude-fable-5",
    ]);
    expect(SERV_FLIP_DECISION_SHORTLIST.map((e) => e.flipOrder)).toEqual([1, 2, 3]);
    expect(SERV_FLIP_DECISION_SHORTLIST[1]!.inputPerMDisplay).toBe("$5.25");
    expect(SERV_FLIP_DECISION_SHORTLIST[2]!.outputPerMDisplay).toBe("$65.00");
    expect([...SERV_FLIP_SUPERSEDED_AUTOMATIC_NEXT]).toEqual(["gpt-6.1-sol", "claude-opus-5.5"]);
  });

  it("resolves shortlist without ALLOW_UNLISTED", () => {
    const r = resolveServCompareModelIds(SERV_FLIP_DECISION_SHORTLIST_IDS.join(","));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.models.map((m) => m.id)).toEqual([...SERV_FLIP_DECISION_SHORTLIST_IDS]);
    expect(r.models.every((m) => m.kind === "flip_decision_shortlist")).toBe(true);
  });

  it("profile override accepts gpt-5.6-sol and claude-fable-5 first-class", () => {
    for (const id of ["gpt-5.6-sol", "claude-fable-5", "claude-sonnet-5.5"] as const) {
      expect(isFlipDecisionShortlistId(id)).toBe(true);
      const r = resolveProfileBaseModel("scout_plan", {
        env: { SERV_PROFILE_MODEL_SCOUT_PLAN: id },
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.baseId).toBe(id);
      expect(r.overrideActive).toBe(true);
    }
    const findProfile = resolveProfileBaseModel("find_next_check", {
      env: { SERV_PROFILE_MODEL_FIND_NEXT_CHECK: "gpt-5.6-sol" },
    });
    expect(findProfile.ok).toBe(true);
    if (!findProfile.ok) return;
    expect(findProfile.baseId).toBe("gpt-5.6-sol");
  });

  it("listServFlipDecisionShortlist matches shortlist length", () => {
    expect(listServFlipDecisionShortlist()).toHaveLength(3);
  });
});
