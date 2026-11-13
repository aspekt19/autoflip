import type {
  CriterionScore,
  ProviderCost,
  SearchSnapshot,
  SnapshotArmDecision,
} from "./types";

const TITLE_BRAND_PATTERN = /salvage|rebuilt|flood|lemon|branded/i;

export function scoreSnapshotDecision(
  snapshot: SearchSnapshot,
  decision: SnapshotArmDecision,
): CriterionScore[] {
  const byVin = new Map(snapshot.candidates.map((row) => [row.vin.trim().toUpperCase(), row]));
  const primaryVin = decision.primaryVin?.trim().toUpperCase() || null;
  const primary = primaryVin ? byVin.get(primaryVin) : undefined;
  const nearMisses = decision.nearMissVins.map((vin) => vin.trim().toUpperCase()).filter(Boolean);
  const nearMissesAreInSnapshot =
    nearMisses.length > 0 && nearMisses.every((vin) => byVin.has(vin));

  return snapshot.criteria.map((criterion) => {
    if (criterion.id === "no_accident_primary") {
      if (!primaryVin) {
        const validNothingFits =
          decision.nothingFits && !decision.primaryVin && nearMissesAreInSnapshot;
        return {
          id: criterion.id,
          pass: validNothingFits,
          detail: validNothingFits
            ? "No clean primary pick; every named near miss belongs to the frozen snapshot."
            : "No valid primary pick, or nothing-fits lacks snapshot-backed near misses.",
        };
      }
      if (!primary) {
        return {
          id: criterion.id,
          pass: false,
          detail: `${primaryVin} is not present in the frozen snapshot.`,
        };
      }
      if (primary.accidentCount == null) {
        return {
          id: criterion.id,
          pass: false,
          detail: "Accident history is unknown; this cannot be scored as a verified clean vehicle.",
        };
      }
      const dirty =
        primary.accidentCount >= 1 ||
        Boolean(primary.titleBrand && TITLE_BRAND_PATTERN.test(primary.titleBrand));
      return {
        id: criterion.id,
        pass: !dirty,
        detail: dirty
          ? `${primaryVin} has reported accident history or a branded title.`
          : "Snapshot reports zero accidents and no branded title.",
      };
    }

    if (criterion.id === "radius_when_known") {
      if (!primaryVin) {
        return {
          id: criterion.id,
          pass: false,
          detail: "No primary vehicle was selected; radius compliance was not demonstrated.",
        };
      }
      if (!primary) {
        return {
          id: criterion.id,
          pass: false,
          detail: `${primaryVin} is not present in the frozen snapshot.`,
        };
      }
      if (snapshot.radiusMi == null) {
        return {
          id: criterion.id,
          pass: false,
          detail: "Snapshot has no radius threshold to verify.",
        };
      }
      if (primary.distanceMiles == null || primary.radiusCheck !== "known") {
        return {
          id: criterion.id,
          pass: false,
          detail: "Distance is unverified; this criterion is not counted as a pass.",
        };
      }
      const inside = primary.distanceMiles <= snapshot.radiusMi;
      return {
        id: criterion.id,
        pass: inside,
        detail: inside
          ? `${primary.distanceMiles} mi is inside ${snapshot.radiusMi} mi.`
          : `${primary.distanceMiles} mi is outside ${snapshot.radiusMi} mi.`,
      };
    }

    if (criterion.id === "structured_offer") {
      const proseNamesOffer = /\boffer\b/i.test(decision.why) && /\$\s?\d/.test(decision.why);
      if (!proseNamesOffer) {
        return {
          id: criterion.id,
          pass: true,
          detail: "No dollar-denominated offer is claimed in the decision prose.",
        };
      }
      const openingValid =
        decision.openingOffer != null && Number.isFinite(decision.openingOffer) && decision.openingOffer > 0;
      const walkAwayValid =
        decision.walkAway != null && Number.isFinite(decision.walkAway) && decision.walkAway > 0;
      const ordered =
        openingValid && walkAwayValid && decision.openingOffer! <= decision.walkAway!;
      return {
        id: criterion.id,
        pass: ordered,
        detail: ordered
          ? "Prose offer is backed by positive, ordered openingOffer and walkAway values."
          : "Prose names an offer but structured offer values are missing, invalid, or reversed.",
      };
    }

    return { id: criterion.id, pass: false, detail: `No scorer for ${criterion.id}.` };
  });
}

export function readProviderCost(payload: unknown): ProviderCost {
  if (payload && typeof payload === "object") {
    const row = payload as Record<string, unknown>;
    const direct = row.providerCost ?? (row.usage as Record<string, unknown> | undefined)?.cost;
    if (typeof direct === "number" && Number.isFinite(direct)) {
      return { usd: direct, source: "provider" };
    }
  }
  return { usd: null, source: "harness estimate" };
}
