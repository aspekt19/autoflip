/**
 * Template pools for live-eval note generation.
 * Cities carry a ZIP so geo searches stay realistic; nationwide notes leave zip null.
 */

export type CityTemplate = {
  id: string;
  name: string;
  zip: string;
  radiusMi: number;
};

export type BudgetTemplate = {
  id: string;
  /** Phrase fragment mentioning money. */
  phrase: string;
};

export type BodyTemplate = {
  id: string;
  phrase: string;
};

export type NeedTemplate = {
  id: string;
  phrase: string;
};

export type MessyTemplate = {
  id: string;
  /** Wrap the clean sentence; `{note}` is the filled clean note. */
  wrap: (note: string) => string;
};

export const CITIES: readonly CityTemplate[] = [
  { id: "dallas", name: "Dallas", zip: "75201", radiusMi: 100 },
  { id: "austin", name: "Austin", zip: "78701", radiusMi: 75 },
  { id: "denver", name: "Denver", zip: "80202", radiusMi: 100 },
  { id: "seattle", name: "Seattle", zip: "98101", radiusMi: 50 },
  { id: "chicago", name: "Chicago", zip: "60601", radiusMi: 60 },
  // 30303 = Atlanta city-center; 30301 is PO-box-only and Auto.dev cannot geocode it.
  { id: "atlanta", name: "Atlanta", zip: "30303", radiusMi: 80 },
  { id: "phoenix", name: "Phoenix", zip: "85001", radiusMi: 90 },
  { id: "miami", name: "Miami", zip: "33101", radiusMi: 70 },
  { id: "minneapolis", name: "Minneapolis", zip: "55401", radiusMi: 80 },
  { id: "portland", name: "Portland", zip: "97201", radiusMi: 60 },
  { id: "nashville", name: "Nashville", zip: "37201", radiusMi: 90 },
  { id: "raleigh", name: "Raleigh", zip: "27601", radiusMi: 75 },
  { id: "columbus", name: "Columbus", zip: "43215", radiusMi: 80 },
  { id: "nationwide", name: "nationwide", zip: "", radiusMi: 0 },
];

export const BUDGETS: readonly BudgetTemplate[] = [
  { id: "8k", phrase: "around $8,000" },
  { id: "10k", phrase: "under ten thousand" },
  { id: "12k", phrase: "under $12k" },
  { id: "15k", phrase: "about $15,000" },
  { id: "18k", phrase: "around eighteen thousand" },
  { id: "20k", phrase: "around $20k" },
  { id: "22k", phrase: "max $22,500" },
  { id: "25k", phrase: "max $25,000" },
  { id: "28k", phrase: "budget is about $28k" },
  { id: "30k", phrase: "around $30k" },
  { id: "35k", phrase: "under thirty five thousand" },
  { id: "40k", phrase: "budget is $40k" },
  { id: "45k", phrase: "up to forty five thousand" },
];

export const BODIES: readonly BodyTemplate[] = [
  { id: "suv", phrase: "a used SUV" },
  { id: "sedan", phrase: "a reliable sedan" },
  { id: "truck", phrase: "a pickup truck" },
  { id: "crossover", phrase: "a compact crossover" },
  { id: "hatch", phrase: "a hatchback" },
  { id: "minivan", phrase: "a minivan" },
  { id: "any", phrase: "a used car" },
  { id: "wagon", phrase: "a wagon or crossover" },
  { id: "coupe", phrase: "a coupe" },
  { id: "hybrid_suv", phrase: "a hybrid SUV or crossover" },
  { id: "small_suv", phrase: "a small SUV" },
];

export const NEEDS: readonly NeedTemplate[] = [
  { id: "commute", phrase: "mostly for commuting, something reliable" },
  { id: "family", phrase: "for a family of four, preferably AWD" },
  { id: "tow", phrase: "that can tow a small trailer" },
  { id: "snow", phrase: "good in snow, AWD or 4WD required" },
  { id: "first", phrase: "as a first car, low miles if possible" },
  { id: "roadtrip", phrase: "comfortable for road trips, under 80k miles" },
  { id: "hybrid", phrase: "prefer hybrid for fuel cost" },
  { id: "cheap", phrase: "cheap to insure and maintain" },
  { id: "cargo", phrase: "lots of cargo space for weekend gear" },
  { id: "newer", phrase: "2019 or newer if I can stretch" },
  { id: "quiet", phrase: "quiet cabin for long highway drives" },
  { id: "pets", phrase: "easy to clean with dogs in the back" },
  { id: "city", phrase: "easy to park in a dense city" },
  { id: "no_salvage", phrase: "clean title only, nothing salvage" },
];

export const MESSY: readonly MessyTemplate[] = [
  {
    id: "typos",
    wrap: (note) =>
      note
        .replace(/Looking/i, "lookin")
        .replace(/around/i, "arund")
        .replace(/Prefer/i, "preffer"),
  },
  {
    id: "runon",
    wrap: (note) => `${note} also maybe leather seats idk not a dealbreaker tho??`,
  },
  {
    id: "caps",
    wrap: (note) => note.toUpperCase(),
  },
  {
    id: "filler",
    wrap: (note) => `hey so um ${note.toLowerCase()} thanks!!`,
  },
  {
    id: "fragments",
    wrap: (note) => note.replace(/\.\s*$/, "") + " — thoughts? asap please",
  },
  {
    id: "clean",
    wrap: (note) => note,
  },
];

/** Assemble a clean Find note before optional messy wrapping. */
export function assembleCleanNote(input: {
  body: BodyTemplate;
  budget: BudgetTemplate;
  need: NeedTemplate;
  city: CityTemplate;
}): string {
  const where =
    input.city.id === "nationwide"
      ? "Anywhere in the US is fine"
      : `Near ${input.city.name} (${input.city.zip})`;
  return `Looking for ${input.body.phrase} ${input.budget.phrase}. ${input.need.phrase}. ${where}.`;
}

export type FlipGoalTemplate = {
  id: string;
  phrase: string;
};

/** Flip-oriented need lines for Resale agent eval notes. */
export const FLIP_GOALS: readonly FlipGoalTemplate[] = [
  { id: "quick", phrase: "want a quick flip with clear margin after fees and tax" },
  { id: "local", phrase: "buy local, fix light stuff myself, resell in the same market" },
  { id: "thin", phrase: "okay with a thinner margin if days-to-sell looks short" },
  { id: "safe", phrase: "skip do-not-drive recalls; prefer clean title flips" },
  { id: "volume", phrase: "looking for underpriced comps I can wholesale or private-party" },
  { id: "auction", phrase: "open to auction buys if transport math still works" },
  { id: "truck_flip", phrase: "prefer trucks or SUVs that turn faster in this metro" },
  { id: "as_is", phrase: "as-is flips are fine if the discount covers risk" },
];

/** Assemble a clean Resale/flip note before optional messy wrapping. */
export function assembleResaleNote(input: {
  body: BodyTemplate;
  budget: BudgetTemplate;
  goal: FlipGoalTemplate;
  city: CityTemplate;
}): string {
  const where =
    input.city.id === "nationwide"
      ? "Nationwide sourcing is fine"
      : `Around ${input.city.name} (${input.city.zip})`;
  return `Flip search: ${input.body.phrase} ${input.budget.phrase}. ${input.goal.phrase}. ${where}.`;
}
