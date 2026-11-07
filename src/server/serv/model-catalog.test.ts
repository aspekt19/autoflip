import { describe, expect, it } from "vitest";
import { BASE_MODEL } from "./profiles";
import {
  SERV_COMPARE_BASE_MODEL_IDS,
  listServCompareModels,
  resolveServCompareModelIds,
  servCompareCatalogNote,
} from "./model-catalog";

describe("SERV compare model catalog (in-repo evidence only)", () => {
  it("includes BASE_MODEL and dated alias from committed eval artifacts", () => {
    expect(SERV_COMPARE_BASE_MODEL_IDS).toContain(BASE_MODEL);
    expect(SERV_COMPARE_BASE_MODEL_IDS).toContain("gpt-5.4-mini-2026-03-17");
    const listed = listServCompareModels();
    expect(listed.every((m) => m.effectiveForScoutPlan.length > 0)).toBe(true);
    expect(servCompareCatalogNote()).toMatch(/BASE_MODEL/);
  });

  it("rejects unknown model ids fail-closed", () => {
    const bad = resolveServCompareModelIds("gpt-4o,not-a-model");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toMatch(/Unsupported/);
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
