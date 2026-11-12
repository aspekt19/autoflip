/**
 * G1–G10 from docs/STABILIZATION.md §5.
 * ZIP 10001 and radius 100 mi unless the case says otherwise.
 * "+" in the spec is a later turn (form confirm or another note).
 */

export type GoldenCaseId =
  | "G1"
  | "G2"
  | "G3"
  | "G4"
  | "G5"
  | "G6"
  | "G7"
  | "G8"
  | "G9"
  | "G10"
  | "L1"
  | "L2"
  | "L3"
  | "L4"
  | "L5"
  | "L6"
  | "L7"
  | "L8"
  | "L9"
  | "L10";

export type CaseTurn =
  | { note: string }
  | { confirm: { yearMin?: number; zip?: string | null; distanceMiles?: number | null } };

export type CaseExpect = {
  budgetUsd?: number;
  /** Hard year floor. "newer than 2019" is 2020. */
  yearMin?: number;
  milesMax?: number;
  /** Shown price must be ≤ budget × 1.05 (documented slight-over rule). */
  priceCeilUsd?: number;
  zip?: string | null;
  zipSource?: "note" | "form";
  radiusMi?: number | null;
  /** Shown models must be in this set. */
  models?: string[];
  excludeMakes?: string[];
  drivetrain?: "awd_4wd";
  accidents?: "none_or_flagged";
  seatsMin?: number;
  fuel?: "hybrid";
  towing?: "unknown";
  /** Resale: miles ceiling the ranker must enforce (G4). */
  resaleMilesCeil?: number;
  asIsReconZero?: boolean;
  sellWithinDays?: number;
  noDefaultTarget?: boolean;
  queriesRequired?: boolean;
  /** Hand-written fixture responses. Replay does not have live SERV recordings for these. */
  scripted?: "live-a" | "live-b" | "live-c" | "live-d" | "live-rank" | "live-suv";
  noMilesMax?: boolean;
  noVerdictWhenEmpty?: boolean;
  /** Distinct make/model pairs the inventory URLs must include. */
  minModels?: number;
  /** Shown listings must include this model. */
  includesModel?: string;
  /** The ranked pick, when the decide step runs. */
  pickVin?: string;
  /** Hard drivetrain drops cars whose drivetrain is blank. */
  excludeUnknownDrivetrain?: boolean;
  /** Permalink must not recommend a pass as a best flip. */
  passIsNotAFlip?: boolean;
  /** Shown cars at or above 160,000 miles must be flagged. */
  flagVeryHighMiles?: boolean;
};

export type GoldenCase = {
  id: GoldenCaseId;
  kind: "personal" | "flip" | "sequence";
  scripted?: "live-a" | "live-b" | "live-c" | "live-d" | "live-rank" | "live-suv";
  /** from-note: do not overwrite a ZIP the note resolved. nationwide: radius null, no ZIP. */
  location: { zip: string; radiusMi: number } | "from-note" | "nationwide";
  turns: CaseTurn[];
  /** sequence cases search after every note. Others search once, after the last turn. */
  search: "each" | "final";
  expect: CaseExpect;
};

const NYC = { zip: "10001", radiusMi: 100 } as const;

export const GOLDEN_CASES: readonly GoldenCase[] = [
  {
    id: "G1",
    kind: "personal",
    location: NYC,
    search: "final",
    turns: [
      { note: "I need a reliable first car, budget about $8,000" },
      { note: "I need a reliable first car, budget about $8,000. it's for a new driver" },
    ],
    expect: { budgetUsd: 8000, priceCeilUsd: 8400, queriesRequired: true },
  },
  {
    id: "G2",
    kind: "personal",
    location: NYC,
    search: "final",
    turns: [
      { note: "Looking for a pickup truck that can tow a camper, budget around $30k" },
      { confirm: { yearMin: 2018 } },
      { note: "Looking for a pickup truck that can tow a camper, budget around $30k. prefer 4x4" },
    ],
    expect: { budgetUsd: 30000, priceCeilUsd: 31500, yearMin: 2018, towing: "unknown" },
  },
  {
    id: "G3",
    kind: "personal",
    location: NYC,
    search: "final",
    turns: [{ note: "Family SUV under $20k, AWD, no accidents" }],
    expect: {
      budgetUsd: 20000,
      priceCeilUsd: 21000,
      drivetrain: "awd_4wd",
      accidents: "none_or_flagged",
    },
  },
  {
    id: "G4",
    kind: "flip",
    location: NYC,
    search: "final",
    turns: [{ note: "buy as-is, sell within 30 days" }],
    expect: {
      budgetUsd: 15000,
      priceCeilUsd: 15750,
      resaleMilesCeil: 180_000,
      asIsReconZero: true,
      sellWithinDays: 30,
      noDefaultTarget: true,
    },
  },
  {
    id: "G5",
    kind: "personal",
    location: NYC,
    search: "final",
    turns: [{ note: "Honda Civic or Toyota Corolla under 15 grand, less than 60k miles" }],
    expect: { budgetUsd: 15000, priceCeilUsd: 15750, milesMax: 60_000, models: ["Civic", "Corolla"] },
  },
  {
    id: "G6",
    kind: "personal",
    location: "from-note",
    search: "final",
    turns: [{ note: "cheap commuter with great gas mileage, max 12k, near Chicago" }],
    expect: { budgetUsd: 12000, priceCeilUsd: 12600, zip: "60601", zipSource: "note" },
  },
  {
    id: "G7",
    kind: "personal",
    location: NYC,
    search: "final",
    turns: [{ note: "7 seats, minivan or 3-row SUV, $25,000 tops, not a Kia" }],
    expect: { budgetUsd: 25000, priceCeilUsd: 26250, excludeMakes: ["Kia"], seatsMin: 7 },
  },
  {
    id: "G8",
    kind: "personal",
    location: NYC,
    search: "final",
    turns: [{ note: "I want a hybrid, budget 18-22k, newer than 2019" }],
    expect: { budgetUsd: 22000, priceCeilUsd: 23100, yearMin: 2020, fuel: "hybrid" },
  },
  {
    id: "G9",
    kind: "sequence",
    location: NYC,
    search: "each",
    turns: [{ note: "SUV under $20,000" }, { note: "reliable first car about $8,000" }],
    expect: { budgetUsd: 8000, priceCeilUsd: 8400 },
  },
  {
    id: "G10",
    kind: "flip",
    location: "nationwide",
    search: "final",
    turns: [{ note: "Nationwide" }],
    expect: { budgetUsd: 5000, priceCeilUsd: 5250, radiusMi: null, zip: null, queriesRequired: true },
  },
  {
    id: "L1",
    kind: "personal",
    scripted: "live-a",
    location: "from-note",
    search: "final",
    turns: [
      { note: "First car for my daughter, safe and cheap to run, max 12k, near Chicago, newer than 2019" },
      { confirm: { zip: "60601", distanceMiles: 50 } },
    ],
    expect: {
      budgetUsd: 12000,
      priceCeilUsd: 12600,
      yearMin: 2020,
      zip: "60601",
      radiusMi: 50,
      noMilesMax: true,
      noVerdictWhenEmpty: true,
      queriesRequired: true,
    },
  },
  {
    id: "L2",
    kind: "personal",
    scripted: "live-b",
    location: { zip: "80202", radiusMi: 100 },
    search: "final",
    turns: [{ note: "Used compact SUV with AWD under $25,000 near Denver, 2018 or newer, under 80k miles" }],
    expect: {
      budgetUsd: 25000,
      priceCeilUsd: 26250,
      yearMin: 2018,
      milesMax: 80000,
      zip: "80202",
      radiusMi: 100,
      drivetrain: "awd_4wd",
      queriesRequired: true,
    },
  },
  {
    id: "L3",
    kind: "personal",
    scripted: "live-c",
    location: "from-note",
    search: "final",
    turns: [
      {
        note: "first car for a new driver in Chicago, max $12k, up to 120k miles, safe and cheap to run",
      },
    ],
    expect: {
      budgetUsd: 12000,
      priceCeilUsd: 12600,
      milesMax: 120_000,
      zip: "60601",
      queriesRequired: true,
      minModels: 4,
      includesModel: "Camry",
    },
  },
  {
    id: "L4",
    kind: "personal",
    scripted: "live-d",
    location: NYC,
    search: "final",
    turns: [{ note: "Family SUV under $20k, must have AWD, no accidents" }],
    expect: {
      budgetUsd: 20000,
      priceCeilUsd: 21000,
      drivetrain: "awd_4wd",
      excludeUnknownDrivetrain: true,
      queriesRequired: true,
    },
  },
  {
    id: "L5",
    kind: "flip",
    location: NYC,
    search: "final",
    turns: [{ note: "a few hundred dollars is not a flip" }],
    expect: {
      budgetUsd: 10000,
      priceCeilUsd: 10500,
      queriesRequired: true,
      passIsNotAFlip: true,
    },
  },
  {
    id: "L6",
    kind: "personal",
    scripted: "live-rank",
    location: NYC,
    search: "final",
    turns: [{ note: "Used SUV under $15,000" }],
    expect: {
      budgetUsd: 15000,
      priceCeilUsd: 15750,
      queriesRequired: true,
      pickVin: "JF1SJADC8HH000003",
    },
  },
  {
    id: "L7",
    kind: "personal",
    scripted: "live-a",
    location: NYC,
    search: "final",
    turns: [{ note: "Honda Civic under $15,000 near me" }],
    expect: { budgetUsd: 15000, priceCeilUsd: 15750, queriesRequired: true },
  },
  {
    id: "L8",
    kind: "flip",
    location: NYC,
    search: "final",
    turns: [{ note: "skip the second review" }],
    expect: { budgetUsd: 15000, priceCeilUsd: 15750, queriesRequired: true },
  },
  {
    id: "L9",
    kind: "personal",
    scripted: "live-suv",
    location: { zip: "80202", radiusMi: 100 },
    search: "final",
    turns: [{ note: "AWD SUV in Denver, budget $25k, must have AWD" }],
    expect: {
      budgetUsd: 25000,
      priceCeilUsd: 26250,
      zip: "80202",
      drivetrain: "awd_4wd",
      queriesRequired: true,
      pickVin: "JF2SJAKC0FH550958",
      flagVeryHighMiles: true,
    },
  },
  {
    id: "L10",
    kind: "personal",
    scripted: "live-suv",
    location: { zip: "80202", radiusMi: 100 },
    search: "final",
    turns: [{ note: "They want an SUV in Denver under $25,000 with AWD" }],
    expect: {
      budgetUsd: 25000,
      priceCeilUsd: 26250,
      drivetrain: "awd_4wd",
      queriesRequired: true,
      pickVin: "JF2SJAKC0FH550958",
    },
  },
];

export function caseById(id: string): GoldenCase {
  const found = GOLDEN_CASES.find((row) => row.id === id);
  if (!found) throw new Error(`Unknown golden case ${id}`);
  return found;
}
