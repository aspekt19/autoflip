/**
 * Per-car note on a Find result card. Only the winning card carries the decision text;
 * every other card gets its own note (the graph's line for that car, or a plain comparison
 * with the pick built from the two cars' own listed price and miles).
 */
export type FindCardCar = {
  key: string;
  vin?: string | null;
  year: number;
  make: string;
  model: string;
  priceUsd?: number | null;
  miles?: number | null;
};

const usd = (value: number) => `$${Math.round(value).toLocaleString("en-US")}`;
const num = (value: number) => Math.round(value).toLocaleString("en-US");

/** "Compared with the pick (2022 Toyota Corolla): asks $4,000 less, 40,411 more miles." Null when nothing is comparable. */
export function compareWithPickNote(car: FindCardCar, pick: FindCardCar | null | undefined): string | null {
  if (!pick || pick.key.toUpperCase() === car.key.toUpperCase()) return null;
  const bits: string[] = [];
  if (car.priceUsd != null && pick.priceUsd != null) {
    const diff = Math.round(car.priceUsd - pick.priceUsd);
    bits.push(diff === 0 ? "asks the same" : `asks ${usd(Math.abs(diff))} ${diff < 0 ? "less" : "more"}`);
  }
  if (car.miles != null && pick.miles != null) {
    const diff = Math.round(car.miles - pick.miles);
    bits.push(diff === 0 ? "same miles" : `${num(Math.abs(diff))} ${diff < 0 ? "fewer" : "more"} miles`);
  }
  if (bits.length === 0) return null;
  return `Compared with the pick (${pick.year} ${pick.make} ${pick.model}): ${bits.join(", ")}.`;
}

export function findCardNote(input: {
  car: FindCardCar;
  pick: FindCardCar | null | undefined;
  /** The decision shown once, on the winning card. */
  decisionText: string | null;
  /** The reviewer's own line for this car (evidence keyed to its VIN), when there is one. */
  carReason: string | null;
}): { note: string | null; isWinner: boolean } {
  const isWinner = Boolean(input.pick && input.pick.key.toUpperCase() === input.car.key.toUpperCase());
  if (isWinner) return { note: input.decisionText?.trim() || input.carReason?.trim() || null, isWinner };
  return {
    note: input.carReason?.trim() || compareWithPickNote(input.car, input.pick),
    isWinner,
  };
}
