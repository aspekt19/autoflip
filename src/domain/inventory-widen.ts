/**
 * Legacy inventory widen helpers. Pre-SERV enforceHard / distance widen is deleted —
 * {@link filterInventoryWithWiden} is a passthrough. softFiltersAppliedAsHard /
 * widenExplanation remain for observational copy / tests.
 */
import type { StructuredNeed } from "./need";
import { type SearchSpec, type ServPlanHint } from "./search-spec";
import type { Listing } from "./types";

export type SoftFilterKind = "awd_soft" | "fuel_hybrid_soft" | "preferred_make_soft" | "body_soft";

export type InventoryFilterDrop = {
  vin: string;
  rule: string;
};

export type WidenStep =
  | { kind: "drop_soft"; filters: SoftFilterKind[]; label: string }
  | { kind: "widen_distance"; fromMiles: number; label: string };

export type InventoryWidenResult = {
  listings: Listing[];
  dropped: InventoryFilterDrop[];
  steps: WidenStep[];
  explanation: string | null;
};

/**
 * Soft preferences that were applied as inventory filters.
 * Prefer SearchSpec.soft (SERV strengths) — never re-parse note / mustHaves.
 */
export function softFiltersAppliedAsHard(
  need: Pick<StructuredNeed, "openToOtherMakes" | "preferredMakes" | "bodyStyle">,
  spec?: SearchSpec,
): SoftFilterKind[] {
  const out: SoftFilterKind[] = [];
  if (spec) {
    if (spec.soft.drivetrain?.value === "awd_4wd") out.push("awd_soft");
    if (spec.soft.fuel?.value) out.push("fuel_hybrid_soft");
    if (spec.soft.bodyStyles?.value?.length) out.push("body_soft");
    const makes = need.preferredMakes ?? [];
    if (makes.length > 0 && need.openToOtherMakes === false) out.push("preferred_make_soft");
    return out;
  }
  // Legacy path without a SearchSpec — keep preferred-make lock detection only.
  const makes = need.preferredMakes ?? [];
  if (makes.length > 0 && need.openToOtherMakes === false) out.push("preferred_make_soft");
  return out;
}

/**
 * Filter inventory with hard gates + listingWithinNeed, then auto-widen.
 * Pre-SERV enforceHard / widen product filters are deleted. SERV owns search /
 * re-search / relax via search_listings. Return inventory unchanged.
 */
export function filterInventoryWithWiden(
  listings: readonly Listing[],
  _need: StructuredNeed,
  _opts?: { servPlan?: ServPlanHint },
): InventoryWidenResult {
  void _need;
  void _opts;
  return {
    listings: [...listings],
    dropped: [],
    steps: [],
    explanation: null,
  };
}

export function widenExplanation(input: {
  excludeLabel: string | null;
  steps: readonly WidenStep[];
  recovered: number;
  hadInventory: number;
}): string | null {
  if (input.hadInventory === 0) return null;
  if (input.steps.length === 0) return null;
  const excluded = input.excludeLabel ?? "those filters";
  const soft = input.steps.find((s) => s.kind === "drop_soft");
  const dist = input.steps.find((s) => s.kind === "widen_distance");
  const parts: string[] = [];
  if (soft) {
    parts.push(
      `No cars matched with ${soft.label} within your other limits, so we loosened ${soft.label}`,
    );
  } else {
    parts.push(`No cars matched with ${excluded}`);
  }
  if (dist) {
    parts.push(
      soft
        ? `then widened the search distance (${dist.label})`
        : `so we widened the search distance (${dist.label}) on the cars already returned`,
    );
  }
  const base = parts.join(", ");
  if (input.recovered > 0) {
    return `${base}. Showing ${input.recovered} car${input.recovered === 1 ? "" : "s"} after widening.`;
  }
  return `${base}. Still no matching cars after widening soft filters${dist ? " and distance" : ""}.`;
}
