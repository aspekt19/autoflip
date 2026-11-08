import { describe, expect, it } from "vitest";
import {
  SERV_FLIP_DECISION_SHORTLIST,
  SERV_FLIP_DECISION_SHORTLIST_IDS,
  isFlipDecisionShortlistId,
} from "./flip-decision-shortlist";
import { resolveServCompareModelIds, listServFlipDecisionShortlist } from "./model-catalog";
import { resolveProfileBaseModel } from "./profile-models";

describe("Flip t318 decision shortlist (console CSV exact IDs)", () => {
  it("uses exact parent shortlist order and CSV model_ids", () => {
    expect(SERV_FLIP_DECISION_SHORTLIST_IDS).toEqual([
      "claude-sonnet-5.5",
      "gpt-6.1-sol",
      "claude-opus-5.5",
    ]);
    expect(SERV_FLIP_DECISION_SHORTLIST.map((e) => e.flipOrder)).toEqual([1, 2, 3]);
    expect(SERV_FLIP_DECISION_SHORTLIST[0]!.inputPerMDisplay).toBe("$2.40");
    expect(SERV_FLIP_DECISION_SHORTLIST[1]!.modelId).toBe("gpt-6.1-sol");
    expect(SERV_FLIP_DECISION_SHORTLIST[2]!.outputPerMDisplay).toBe("$24.00");
  });

  it("resolves shortlist without ALLOW_UNLISTED", () => {
    const r = resolveServCompareModelIds(SERV_FLIP_DECISION_SHORTLIST_IDS.join(","));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.models.map((m) => m.id)).toEqual([...SERV_FLIP_DECISION_SHORTLIST_IDS]);
    expect(r.models.every((m) => m.kind === "flip_decision_shortlist")).toBe(true);
  });

  it("profile override accepts shortlist IDs", () => {
    for (const id of SERV_FLIP_DECISION_SHORTLIST_IDS) {
      expect(isFlipDecisionShortlistId(id)).toBe(true);
      const r = resolveProfileBaseModel("scout_plan", {
        env: { SERV_PROFILE_MODEL_SCOUT_PLAN: id },
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.baseId).toBe(id);
    }
  });

  it("listServFlipDecisionShortlist matches shortlist length", () => {
    expect(listServFlipDecisionShortlist()).toHaveLength(3);
  });
});
