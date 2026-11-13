import { describe, expect, it } from "vitest";
import { BASE_MODEL } from "@/server/serv/profiles";
import { resolveProfileBaseModel } from "@/server/serv/profile-models";
import {
  buildFindNextCheckChoiceSchema,
  clampFindNextCheckChoice,
  normalizeFindNextCheckChoiceId,
  parseFindNextCheckChoice,
  sanitizeDeniedCheckId,
} from "./find-next-check-choice";
import { FIND_NEXT_CHECK_IDS, type FindNextCheckId } from "./find-next-checks";

describe("find next-check choice allowlist alignment", () => {
  it("live schema enum is the allowlist subset — not the full catalog (PR80 root cause)", () => {
    const allowed: FindNextCheckId[] = [
      "free_gov_recalls",
      "free_gov_safety",
      "compare_observed_asks",
      "run_full_analysis",
      "get_history_report",
      "widen_or_nationwide",
    ];
    const schema = buildFindNextCheckChoiceSchema(allowed);
    const enumIds = (schema.schema as { properties: { checkId: { enum: string[] } } }).properties
      .checkId.enum;
    expect(enumIds).toEqual(allowed);
    expect(enumIds).not.toContain("free_gov_vpic"); // not in this allowlist
    expect(enumIds.length).toBeLessThan(FIND_NEXT_CHECK_IDS.length);
  });

  it("maps Scout evidence.gov_* aliases to free_gov_* then clamps", () => {
    expect(normalizeFindNextCheckChoiceId("evidence.gov_recalls")).toBe("free_gov_recalls");
    const ok = clampFindNextCheckChoice("evidence.gov_recalls", ["free_gov_recalls", "compare_observed_asks"]);
    expect(ok.clamped).toBe("free_gov_recalls");
    expect(ok.aliasApplied).toBe("evidence.gov_recalls→free_gov_recalls");
    expect(ok.reasonCode).toBe("ok");
  });

  it("surfaces denied id + allowlist without inventing a root cause", () => {
    const denied = clampFindNextCheckChoice("free_gov_vpic", [
      "free_gov_recalls",
      "compare_observed_asks",
    ]);
    expect(denied.clamped).toBeNull();
    expect(denied.deniedCheckId).toBe("free_gov_vpic");
    expect(denied.allowlistIds).toEqual(["free_gov_recalls", "compare_observed_asks"]);
    expect(denied.reasonCode).toBe("check_id_not_in_allowlist");
    expect(sanitizeDeniedCheckId("weird id with spaces!!!")).toBe("<non_conforming_id>");
  });

  it("parses real profile-shaped JSON (not a mock that accepts any id)", () => {
    const parsed = parseFindNextCheckChoice(
      JSON.stringify({ checkId: "free_gov_recalls", note: "check recalls first" }),
    );
    expect(parsed?.checkId).toBe("free_gov_recalls");
    const allowed: FindNextCheckId[] = ["free_gov_recalls", "free_gov_safety"];
    const schema = buildFindNextCheckChoiceSchema(allowed);
    const enumIds = (schema.schema as { properties: { checkId: { enum: string[] } } }).properties
      .checkId.enum;
    expect(enumIds).toContain(parsed!.checkId);
    expect(clampFindNextCheckChoice("invent_best_car", allowed).clamped).toBeNull();
  });

  it("Find profile production default is BASE_MODEL; Sonnet needs ALLOW_UNLISTED; Fable blocked", () => {
    const shared = resolveProfileBaseModel("find_plan", { env: {} });
    expect(shared.ok).toBe(true);
    if (!shared.ok) return;
    expect(shared.baseId).toBe(BASE_MODEL);

    const sol = resolveProfileBaseModel("find_plan", {
      env: { SERV_PROFILE_MODEL_FIND_PLAN: BASE_MODEL },
    });
    expect(sol.ok).toBe(true);
    if (!sol.ok) return;
    expect(sol.baseId).toBe(BASE_MODEL);
    expect(sol.overrideActive).toBe(false);

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

    const fable = resolveProfileBaseModel("find_plan", {
      env: { SERV_PROFILE_MODEL_FIND_PLAN: "claude-fable-5" },
    });
    expect(fable.ok).toBe(false);
    const def = resolveProfileBaseModel("find_plan", { env: {} });
    expect(def.ok).toBe(true);
    if (!def.ok) return;
    expect(def.baseId).toBe(BASE_MODEL);
    expect(def.overrideActive).toBe(false);
  });
});
