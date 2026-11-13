/**
 * Confirmed-brief hard constraint: no accident / no salvage.
 * Code rejects a violating pick the same way it rejects a budget miss.
 * SERV repairs the pick or calls submit_nothing_fits. Missing history does not block.
 */
import type { ShopperBriefConstraint } from "./shopper-brief";

export const NO_ACCIDENT_ALTERNATIVE_TEXT = "does not meet your no-accident rule";

const TITLE_BRAND = /salvage|rebuilt|rebuild|flood|lemon|junk|total[-\s]?loss|branded title|theft recovery/i;

export function briefForbidsAccidents(
  rows: readonly Pick<ShopperBriefConstraint, "key" | "value">[] | null | undefined,
): boolean {
  if (!rows?.length) return false;
  return rows.some((row) => {
    const blob = `${row.key} ${row.value}`.toLowerCase();
    if (!/accident|salvage|wreck|title/.test(blob)) return false;
    return /no|none|without|forbid|clean|zero|not|free/.test(blob);
  });
}

export type HistoryReading =
  | { kind: "violation"; detail: string }
  | { kind: "unverified" }
  | { kind: "clear" };

/** Any source with accidentCount >= 1 or a title brand is a violation. All-unknown stays unverified. */
export function readAccidentHistory(input: {
  accidentCounts?: ReadonlyArray<number | null | undefined>;
  texts?: ReadonlyArray<string | null | undefined>;
}): HistoryReading {
  const counts = input.accidentCounts ?? [];
  for (const count of counts) {
    if (typeof count === "number" && Number.isFinite(count) && count >= 1) {
      const n = Math.floor(count);
      return {
        kind: "violation",
        detail: n === 1 ? "accidentCount 1" : `accidentCount ${n}`,
      };
    }
  }
  for (const text of input.texts ?? []) {
    if (typeof text !== "string" || !text.trim()) continue;
    const match = text.match(TITLE_BRAND);
    if (match) {
      return { kind: "violation", detail: `title brand “${match[0]}”` };
    }
  }
  const statedZero = counts.some((count) => count === 0);
  if (statedZero) return { kind: "clear" };
  return { kind: "unverified" };
}

export function accidentHardConstraintIssue(input: {
  forbidsAccidents: boolean;
  vin: string;
  field: string;
  accidentCounts?: ReadonlyArray<number | null | undefined>;
  texts?: ReadonlyArray<string | null | undefined>;
}): { field: string; message: string } | null {
  if (!input.forbidsAccidents) return null;
  const reading = readAccidentHistory({
    accidentCounts: input.accidentCounts,
    texts: input.texts,
  });
  if (reading.kind !== "violation") return null;
  return {
    field: input.field,
    message: `VIN ${input.vin} ${reading.detail} and the confirmed brief forbids accidents and salvage. This car ${NO_ACCIDENT_ALTERNATIVE_TEXT}. Do not make it the primary pick. Choose a car with no reported accident or title brand, or call submit_nothing_fits and name ${input.vin} among the near misses.`,
  };
}

export function accidentHistoryBuyerLine(accidentCount: number | null | undefined): string | null {
  if (accidentCount == null) return "Accident history unverified";
  return null;
}
