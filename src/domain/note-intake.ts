/**
 * Form-option enums shared by Find / Resale intake UI.
 *
 * Regex / keyword note parsers (`budgetFromText`, `intakeFromNote`, `yearsFromNote`,
 * `awdLimitFromText`, …) are deleted. SERV interprets free text; only
 * `origin: "user"` form fields become constraints.
 */

export type TransmissionPref = "automatic" | "manual";

export type HistoryPref = "no_salvage" | "no_accidents" | "no_salvage_no_accidents";

export const NOTE_BODY_STYLES = [
  "SUV",
  "Sedan",
  "Truck",
  "Hatchback",
  "Van",
  "Wagon",
  "Coupe",
  "Convertible",
  "Minivan",
] as const;
export type NoteBodyStyle = (typeof NOTE_BODY_STYLES)[number];
