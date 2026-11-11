import { describe, expect, it } from "vitest";
import { BASE_MODEL } from "./profiles";
import {
  SERV_COMPARE_BASE_MODEL_IDS,
  SERV_COMPARE_FAIR_SLATE,
  isPlausibleServModelId,
  listServCompareModels,
  listServFairSlateModels,
  resolveServCompareModelIds,
  servCompareCatalogNote,
  servCompareProtocolIssues,
} from "./model-catalog";

describe("SERV compare model catalog (in-repo evidence only)", () => {
  it("includes BASE_MODEL and dated alias from committed eval artifacts", () => {
    expect(SERV_COMPARE_BASE_MODEL_IDS).toContain(BASE_MODEL);
    expect(SERV_COMPARE_BASE_MODEL_IDS).toContain("gpt-5.4-mini-2026-03-17");
    const listed = listServCompareModels();
    expect(listed.every((m) => m.effectiveForScoutPlan.length > 0)).toBe(true);
    expect(listed.every((m) => m.unlistedOptIn === false)).toBe(true);
    expect(servCompareCatalogNote()).toMatch(/BASE_MODEL/);
    expect(servCompareCatalogNote()).toMatch(/Model-only swap is NOT the demonstrated fix/i);
    expect(servCompareCatalogNote()).toMatch(/Budget-conscious/);
    expect(servCompareCatalogNote()).toMatch(/gpt-6-luna|Console vs catalog/i);
  });

  it("docs fair slate pins Sol / Mini / Sonnet / Gemini IDs without live calls", () => {
    expect(SERV_COMPARE_FAIR_SLATE.map((m) => m.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.4-mini",
      "claude-sonnet-4.6",
      "gemini-2.5-flash",
    ]);
    const fair = listServFairSlateModels();
    expect(fair.map((m) => m.provider)).toEqual(["openai", "openai", "anthropic", "google"]);
    const viaFlag = resolveServCompareModelIds("", { fairSlate: true });
    expect(viaFlag.ok).toBe(true);
    if (viaFlag.ok) expect(viaFlag.models.map((m) => m.id)).toEqual(SERV_COMPARE_FAIR_SLATE.map((m) => m.id));
    // Explicit fair IDs allowed without ALLOW_UNLISTED.
    const explicit = resolveServCompareModelIds("gpt-5.6-sol,gpt-5.4-mini,claude-sonnet-4.6,gemini-2.5-flash");
    expect(explicit.ok).toBe(true);
    expect(servCompareProtocolIssues().some((i) => i.id === "gemini_endpoint" && i.class === "integration")).toBe(
      true,
    );
    expect(servCompareProtocolIssues().some((i) => i.id === "anthropic_nullable_enum")).toBe(true);
  });

  it("rejects unknown model ids fail-closed without ALLOW_UNLISTED", () => {
    const bad = resolveServCompareModelIds("gpt-6-luna");
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.message).toMatch(/Unsupported|ALLOW_UNLISTED|fair slate/i);
      expect(bad.message).not.toMatch(/blindly expand/i);
    }
    const worse = resolveServCompareModelIds("gpt-4o,not-a-model");
    expect(worse.ok).toBe(false);
  });

  it("accepts parent-supplied unlisted IDs only with allowUnlisted opt-in", () => {
    const denied = resolveServCompareModelIds("gpt-6-luna", { allowUnlisted: false });
    expect(denied.ok).toBe(false);

    const ok = resolveServCompareModelIds("gpt-6-luna,gpt-5.4-mini", { allowUnlisted: true });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.models.map((m) => m.id)).toEqual(["gpt-6-luna", "gpt-5.4-mini"]);
      expect(ok.models[0]!.kind).toBe("parent_supplied_unlisted");
      expect(ok.models[0]!.unlistedOptIn).toBe(true);
      expect(ok.models[1]!.unlistedOptIn).toBe(false);
    }

    const garbage = resolveServCompareModelIds("../etc/passwd", { allowUnlisted: true });
    expect(garbage.ok).toBe(false);
    expect(isPlausibleServModelId("gpt-6-luna")).toBe(true);
    expect(isPlausibleServModelId("")).toBe(false);
  });

  it("accepts catalog CSV and defaults to full catalog", () => {
    const all = resolveServCompareModelIds("");
    expect(all.ok).toBe(true);
    if (all.ok) expect(all.models.length).toBe(SERV_COMPARE_BASE_MODEL_IDS.length);

    const one = resolveServCompareModelIds(BASE_MODEL);
    expect(one.ok).toBe(true);
    if (one.ok) {
      expect(one.models).toHaveLength(1);
      expect(one.models[0]!.id).toBe(BASE_MODEL);
    }
  });
});
