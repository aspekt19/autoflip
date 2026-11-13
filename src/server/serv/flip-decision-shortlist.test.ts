import { describe, expect, it } from "vitest";
import {
  SERV_FLIP_DECISION_SHORTLIST,
  SERV_FLIP_DECISION_SHORTLIST_IDS,
  SERV_FLIP_EXCLUDED_FROM_PAID,
  SERV_FLIP_SUPERSEDED_AUTOMATIC_NEXT,
  isFlipDecisionShortlistId,
} from "./flip-decision-shortlist";
import { resolveServCompareModelIds, listServFlipDecisionShortlist } from "./model-catalog";
import { resolveProfileBaseModel } from "./profile-models";
import { BASE_MODEL } from "./profiles";

describe("Flip decision shortlist (production = BASE_MODEL only)", () => {
  it("uses BASE_MODEL only (Fable excluded; no Sonnet-first order)", () => {
    expect(SERV_FLIP_DECISION_SHORTLIST_IDS).toEqual([BASE_MODEL]);
    expect(SERV_FLIP_DECISION_SHORTLIST.map((e) => e.flipOrder)).toEqual([1]);
    expect(SERV_FLIP_DECISION_SHORTLIST[0]!.modelId).toBe(BASE_MODEL);
    expect([...SERV_FLIP_EXCLUDED_FROM_PAID]).toEqual(["claude-fable-5"]);
    expect(isFlipDecisionShortlistId("claude-fable-5")).toBe(false);
    expect(isFlipDecisionShortlistId("claude-sonnet-5.5")).toBe(false);
    expect([...SERV_FLIP_SUPERSEDED_AUTOMATIC_NEXT]).toEqual([
      "claude-sonnet-5.5",
      "gpt-5.6-sol",
      "gpt-5.4-mini",
      "claude-opus-5.5",
    ]);
  });

  it("resolves shortlist without ALLOW_UNLISTED", () => {
    const r = resolveServCompareModelIds(SERV_FLIP_DECISION_SHORTLIST_IDS.join(","));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.models.map((m) => m.id)).toEqual([...SERV_FLIP_DECISION_SHORTLIST_IDS]);
    expect(r.models.every((m) => m.kind === "flip_decision_shortlist")).toBe(true);
  });

  it("production profile resolve is BASE_MODEL; Sonnet needs ALLOW_UNLISTED", () => {
    const sol = resolveProfileBaseModel("find_plan", { env: {} });
    expect(sol.ok).toBe(true);
    if (!sol.ok) return;
    expect(sol.baseId).toBe(BASE_MODEL);

    const sonnetBlocked = resolveProfileBaseModel("find_plan", {
      env: { SERV_PROFILE_MODEL_FIND_PLAN: "claude-sonnet-5.5" },
    });
    expect(sonnetBlocked.ok).toBe(false);

    const sonnet = resolveProfileBaseModel("find_plan", {
      env: {
        SERV_PROFILE_MODEL_FIND_PLAN: "claude-sonnet-5.5",
        SERV_PROFILE_MODEL_ALLOW_UNLISTED: "1",
      },
    });
    expect(sonnet.ok).toBe(true);
    if (!sonnet.ok) return;
    expect(sonnet.baseId).toBe("claude-sonnet-5.5");
    expect(sonnet.overrideActive).toBe(true);

    const fableBlocked = resolveProfileBaseModel("find_plan", {
      env: { SERV_PROFILE_MODEL_FIND_PLAN: "claude-fable-5" },
    });
    expect(fableBlocked.ok).toBe(false);
  });

  it("listServFlipDecisionShortlist matches shortlist length", () => {
    expect(listServFlipDecisionShortlist()).toHaveLength(1);
  });
});
