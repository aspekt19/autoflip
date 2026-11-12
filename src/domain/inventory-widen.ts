/**
 * When hard gates / soft-as-filter preferences empty a live inventory, relax in order:
 * soft preferences first, then seller distance → nationwide. Always name what excluded cars.
 */
import { hybridLimitFromText } from "./open-search";
import { awdLimitFromText } from "./note-intake";
import type { StructuredNeed } from "./need";
import { listingWithinNeed } from "./need";
import {
  buildSearchSpec,
  enforceHard,
  hardDropSentence,
  type HardDrop,
  type SearchSpec,
} from "./search-spec";
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

/** Soft preferences that were applied as inventory filters for this need. */
export function softFiltersAppliedAsHard(need: Pick<StructuredNeed, "note" | "openToOtherMakes" | "preferredMakes" | "bodyStyle" | "mustHaves">): SoftFilterKind[] {
  const note = need.note ?? "";
  const out: SoftFilterKind[] = [];
  if (awdLimitFromText(note) === "soft") out.push("awd_soft");
  if (hybridLimitFromText(note) === "soft") out.push("fuel_hybrid_soft");
  const makes = need.preferredMakes ?? [];
  if (makes.length > 0 && need.openToOtherMakes === false && !/\bonly\b|\bmust be\b|\bnothing (?:but|except)\b/i.test(note)) {
    out.push("preferred_make_soft");
  }
  if (need.bodyStyle && /\b(?:preferably|ideally|prefer|would be (?:great|nice)|nice if)\b/i.test(note)) {
    out.push("body_soft");
  }
  return out;
}

function dropSoftFromSpec(spec: SearchSpec, soft: SoftFilterKind[]): SearchSpec {
  const hard = { ...spec.hard };
  if (soft.includes("awd_soft")) delete hard.drivetrain;
  if (soft.includes("body_soft")) delete hard.bodyStyles;
  return { ...spec, hard };
}

function needAfterSoftDrop(
  need: StructuredNeed,
  soft: SoftFilterKind[],
): StructuredNeed {
  let next = need;
  if (soft.includes("preferred_make_soft")) {
    next = { ...next, openToOtherMakes: true };
  }
  if (soft.includes("awd_soft")) {
    next = {
      ...next,
      mustHaves: next.mustHaves.filter((item) => !/\b(awd|4wd|all[\s-]?wheel|four[\s-]?wheel)\b/i.test(item)),
      awdPreference: true,
    };
  }
  if (soft.includes("body_soft")) {
    next = { ...next, bodyStyle: null };
  }
  return next;
}

function softFilterLabel(filters: SoftFilterKind[]): string {
  const parts: string[] = [];
  if (filters.includes("awd_soft")) parts.push("preferably all-wheel drive");
  if (filters.includes("fuel_hybrid_soft")) parts.push("hybrid / fuel preference");
  if (filters.includes("preferred_make_soft")) parts.push("preferred-make-only");
  if (filters.includes("body_soft")) parts.push("preferred body style");
  if (parts.length === 0) return "soft preferences";
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function dominantDropLabel(dropped: readonly HardDrop[] | readonly InventoryFilterDrop[]): string | null {
  if (dropped.length === 0) return null;
  const counts = new Map<string, number>();
  for (const row of dropped) {
    counts.set(row.rule, (counts.get(row.rule) ?? 0) + 1);
  }
  let best: string | null = null;
  let n = 0;
  for (const [rule, count] of counts) {
    if (count > n) {
      best = rule;
      n = count;
    }
  }
  if (!best) return null;
  if (best === "drivetrain") return "all-wheel drive only";
  if (best === "miles") return "your mileage limit";
  if (best === "radius") return "your search distance";
  if (best === "price") return "your budget";
  if (best === "year") return "your year limit";
  if (best === "body") return "the body style filter";
  if (best === "make" || best === "preferred_make") return "preferred-make-only";
  if (best === "accidents") return "accident history";
  return best;
}

/**
 * Filter inventory with hard gates + listingWithinNeed, then auto-widen soft filters
 * and (when still empty) drop the radius filter on already-fetched rows.
 * Distance re-query is the caller's job when kept is still empty and a radius was set.
 */
export function filterInventoryWithWiden(
  listings: readonly Listing[],
  need: StructuredNeed,
): InventoryWidenResult {
  const formEdits = {
    priceMaxUsd:
      need.budgetKnown && need.budgetUsd != null ? { value: need.budgetUsd, dirty: true as const } : undefined,
    yearMin: need.yearMin != null ? { value: need.yearMin, dirty: true as const } : undefined,
    yearMax: need.yearMax != null ? { value: need.yearMax, dirty: true as const } : undefined,
    milesMax: need.milesMax != null ? { value: need.milesMax, dirty: true as const } : undefined,
    radiusMi: { value: need.distanceMiles, dirty: true as const },
  };
  const spec = buildSearchSpec({ note: need.note ?? "", mode: need.mode, formEdits });
  const first = enforceHard(spec, listings);
  const firstKept = first.kept.filter((item) => listingWithinNeed(item, need));
  const firstDrops: InventoryFilterDrop[] = [
    ...first.dropped,
    ...first.kept
      .filter((item) => !listingWithinNeed(item, need))
      .map((item) => ({ vin: item.vin, rule: "preferred_make" as const })),
  ];

  if (firstKept.length > 0 || listings.length === 0) {
    return {
      listings: firstKept,
      dropped: firstDrops,
      steps: [],
      explanation: firstKept.length === 0 && listings.length > 0 ? hardDropSentence(first.dropped) : null,
    };
  }

  const steps: WidenStep[] = [];
  const soft = softFiltersAppliedAsHard(need);
  let workingNeed = need;
  let workingSpec = spec;
  let kept = firstKept;
  let dropped = firstDrops;
  const excludeLabel = dominantDropLabel(firstDrops) ?? softFilterLabel(soft);

  if (soft.length > 0) {
    workingSpec = dropSoftFromSpec(spec, soft);
    workingNeed = needAfterSoftDrop(need, soft);
    const second = enforceHard(workingSpec, listings);
    kept = second.kept.filter((item) => listingWithinNeed(item, workingNeed));
    dropped = [
      ...second.dropped,
      ...second.kept
        .filter((item) => !listingWithinNeed(item, workingNeed))
        .map((item) => ({ vin: item.vin, rule: "preferred_make" as const })),
    ];
    steps.push({
      kind: "drop_soft",
      filters: soft,
      label: softFilterLabel(soft),
    });
  }

  if (kept.length === 0 && need.distanceMiles != null) {
    const noRadius: SearchSpec = {
      ...workingSpec,
      hard: { ...workingSpec.hard, radiusMi: { value: null, source: "form" } },
    };
    const third = enforceHard(noRadius, listings);
    kept = third.kept.filter((item) => listingWithinNeed(item, workingNeed));
    dropped = [
      ...third.dropped,
      ...third.kept
        .filter((item) => !listingWithinNeed(item, workingNeed))
        .map((item) => ({ vin: item.vin, rule: "preferred_make" as const })),
    ];
    steps.push({
      kind: "widen_distance",
      fromMiles: need.distanceMiles,
      label: `within ${need.distanceMiles} miles`,
    });
  }

  const explanation = widenExplanation({
    excludeLabel,
    steps,
    recovered: kept.length,
    hadInventory: listings.length,
  });

  return { listings: kept, dropped, steps, explanation };
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
        ? `then widened beyond ${dist.label}`
        : `so we widened beyond ${dist.label} / tried a broader geography on the cars already returned`,
    );
  }
  const base = parts.join(", ");
  if (input.recovered > 0) {
    return `${base}. Showing ${input.recovered} car${input.recovered === 1 ? "" : "s"} after widening.`;
  }
  return `${base}. Still no matching cars after widening soft filters${dist ? " and distance" : ""}.`;
}
