/**
 * Known model-year issue notes from free public patterns + NHTSA complaint themes.
 * Not a paid history report. Unknown stays unknown.
 */

export type KnownIssueNote = {
  text: string;
  source: string;
};

/** Small curated list of widely reported patterns — not exhaustive. */
const CURATED: Array<{ make: RegExp; model: RegExp; years: [number, number]; text: string }> = [
  {
    make: /toyota/i,
    model: /camry/i,
    years: [2018, 2024],
    text: "Some model years in this range have owner reports about fuel-pump or engine-knock concerns — check open recalls and service bulletins for this VIN.",
  },
  {
    make: /honda/i,
    model: /accord|civic|cr-?v/i,
    years: [2016, 2022],
    text: "Some Honda model years in this range have fuel-pump or A/C compressor complaint clusters — verify recall completion on this VIN.",
  },
  {
    make: /ford/i,
    model: /f-?150|escape|explorer/i,
    years: [2015, 2022],
    text: "Some Ford trucks and SUVs in this range have transmission or camera-related campaigns — confirm which apply to this VIN.",
  },
  {
    make: /hyundai|kia/i,
    model: /.+/i,
    years: [2011, 2022],
    text: "Some Hyundai/Kia engines in this era have theft and engine-failure campaigns — verify anti-theft software and engine campaigns for this VIN.",
  },
];

export function knownModelYearIssues(input: {
  year: number | null;
  make: string | null;
  model: string | null;
  complaintCount?: number | null;
  recallCount?: number | null;
}): KnownIssueNote[] {
  const notes: KnownIssueNote[] = [];
  const year = input.year;
  const make = input.make?.trim() ?? "";
  const model = input.model?.trim() ?? "";
  if (year && make && model) {
    for (const row of CURATED) {
      if (!row.make.test(make) || !row.model.test(model)) continue;
      if (year < row.years[0] || year > row.years[1]) continue;
      notes.push({ text: row.text, source: "curated-model-year-pattern" });
    }
  }
  if (typeof input.recallCount === "number" && input.recallCount > 0) {
    notes.push({
      text: `NHTSA lists ${input.recallCount} model-year recall campaign${input.recallCount === 1 ? "" : "s"} for this year, make, and model. That is not proof this VIN is unrepaired.`,
      source: "nhtsa-recalls",
    });
  }
  if (typeof input.complaintCount === "number" && input.complaintCount > 0) {
    notes.push({
      text: `NHTSA has ${input.complaintCount} owner complaint${input.complaintCount === 1 ? "" : "s"} for this year, make, and model. Complaints are allegations, not verified defects on this VIN.`,
      source: "nhtsa-complaints",
    });
  }
  if (notes.length === 0) {
    notes.push({
      text: "No curated model-year issue note matched, and complaint/recall counts were not available to summarize. That is unknown — not a clean bill of health.",
      source: "unknown",
    });
  }
  return notes;
}
