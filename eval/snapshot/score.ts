import type {
  CriterionScore,
  ProviderCost,
  SearchSnapshot,
  SnapshotArmDecision,
} from "./types";

export function scoreSnapshotDecision(
  snapshot: SearchSnapshot,
  decision: SnapshotArmDecision,
): CriterionScore[] {
  const byVin = new Map(snapshot.candidates.map((row) => [row.vin.toUpperCase(), row]));
  return snapshot.criteria.map((criterion) => {
    if (criterion.id === "no_accident_primary") {
      if (!decision.primaryVin) {
        const named = decision.nearMissVins.length > 0 || /near miss|VIN/i.test(decision.why);
        return {
          id: criterion.id,
          pass: decision.nothingFits && named,
          detail: decision.nothingFits
            ? "Nothing fits, and the near misses are named."
            : "No primary pick and no nothing-fits reason.",
        };
      }
      const car = byVin.get(decision.primaryVin.toUpperCase());
      const dirty =
        (car?.accidentCount != null && car.accidentCount >= 1) ||
        Boolean(car?.titleBrand && /salvage|rebuilt|flood|lemon/i.test(car.titleBrand));
      return {
        id: criterion.id,
        pass: !dirty,
        detail: dirty
          ? `${decision.primaryVin} is the primary pick and fails the no-accident rule.`
          : "Primary pick has no reported accident or title brand.",
      };
    }
    if (criterion.id === "radius_when_known") {
      if (!decision.primaryVin || snapshot.radiusMi == null) {
        return { id: criterion.id, pass: true, detail: "No primary pick or no radius to enforce." };
      }
      const car = byVin.get(decision.primaryVin.toUpperCase());
      if (!car || car.radiusCheck === "unverified" || car.distanceMiles == null) {
        return {
          id: criterion.id,
          pass: true,
          detail: "Distance unverified — missing miles do not block.",
        };
      }
      const inside = car.distanceMiles <= snapshot.radiusMi;
      return {
        id: criterion.id,
        pass: inside,
        detail: inside
          ? `${car.distanceMiles} mi is inside ${snapshot.radiusMi} mi.`
          : `${car.distanceMiles} mi is outside ${snapshot.radiusMi} mi.`,
      };
    }
    if (criterion.id === "structured_offer") {
      const proseHasOffer = /\$\s?\d/.test(decision.why) && /\boffer\b/i.test(decision.why);
      if (!proseHasOffer) {
        return { id: criterion.id, pass: true, detail: "Prose does not name an offer." };
      }
      const filled = decision.openingOffer != null || decision.walkAway != null;
      return {
        id: criterion.id,
        pass: filled,
        detail: filled
          ? "Structured openingOffer or walkAway is set."
          : "Prose names an offer and both structured fields are empty.",
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
