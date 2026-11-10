/**
 * Statewide base sales-tax rates for an out-the-door estimate.
 * Local city/county add-ons are not applied — the buyer copy says they are unknown.
 *
 * Source: Tax Foundation, “State and Local Sales Tax Rates as of January 1, 2026”
 * https://taxfoundation.org/data/all/state/sales-tax-rates/
 * Retrieved 2026-11-09. Rates below are the state column only.
 * Footnote (a) on that table: California (1.25%), Utah (1.25%), and Virginia (1%)
 * include a mandatory statewide local add-on inside the state rate. Those amounts
 * are not added again.
 */

export const STATE_SALES_TAX_AS_OF = "2026-01-01";
export const STATE_SALES_TAX_SOURCE_URL = "https://taxfoundation.org/data/all/state/sales-tax-rates/";
export const STATE_SALES_TAX_SOURCE_LABEL = "Tax Foundation statewide base sales tax";

export type StateSalesTax = {
  code: string;
  name: string;
  /** Thousandths of a percent. 5500 = 5.5%. */
  milliPercent: number;
  /** Portion of milliPercent that Tax Foundation already folded in as a statewide local add-on. */
  statewideLocalMilli: number | null;
};

const ROWS: Record<string, { name: string; milliPercent: number; statewideLocalMilli?: number }> = {
  AL: { name: "Alabama", milliPercent: 4000 },
  AK: { name: "Alaska", milliPercent: 0 },
  AZ: { name: "Arizona", milliPercent: 5600 },
  AR: { name: "Arkansas", milliPercent: 6500 },
  CA: { name: "California", milliPercent: 7250, statewideLocalMilli: 1250 },
  CO: { name: "Colorado", milliPercent: 2900 },
  CT: { name: "Connecticut", milliPercent: 6350 },
  DE: { name: "Delaware", milliPercent: 0 },
  FL: { name: "Florida", milliPercent: 6000 },
  GA: { name: "Georgia", milliPercent: 4000 },
  HI: { name: "Hawaii", milliPercent: 4000 },
  ID: { name: "Idaho", milliPercent: 6000 },
  IL: { name: "Illinois", milliPercent: 6250 },
  IN: { name: "Indiana", milliPercent: 7000 },
  IA: { name: "Iowa", milliPercent: 6000 },
  KS: { name: "Kansas", milliPercent: 6500 },
  KY: { name: "Kentucky", milliPercent: 6000 },
  LA: { name: "Louisiana", milliPercent: 5000 },
  ME: { name: "Maine", milliPercent: 5500 },
  MD: { name: "Maryland", milliPercent: 6000 },
  MA: { name: "Massachusetts", milliPercent: 6250 },
  MI: { name: "Michigan", milliPercent: 6000 },
  MN: { name: "Minnesota", milliPercent: 6875 },
  MS: { name: "Mississippi", milliPercent: 7000 },
  MO: { name: "Missouri", milliPercent: 4225 },
  MT: { name: "Montana", milliPercent: 0 },
  NE: { name: "Nebraska", milliPercent: 5500 },
  NV: { name: "Nevada", milliPercent: 6850 },
  NH: { name: "New Hampshire", milliPercent: 0 },
  NJ: { name: "New Jersey", milliPercent: 6625 },
  NM: { name: "New Mexico", milliPercent: 4875 },
  NY: { name: "New York", milliPercent: 4000 },
  NC: { name: "North Carolina", milliPercent: 4750 },
  ND: { name: "North Dakota", milliPercent: 5000 },
  OH: { name: "Ohio", milliPercent: 5750 },
  OK: { name: "Oklahoma", milliPercent: 4500 },
  OR: { name: "Oregon", milliPercent: 0 },
  PA: { name: "Pennsylvania", milliPercent: 6000 },
  RI: { name: "Rhode Island", milliPercent: 7000 },
  SC: { name: "South Carolina", milliPercent: 6000 },
  SD: { name: "South Dakota", milliPercent: 4200 },
  TN: { name: "Tennessee", milliPercent: 7000 },
  TX: { name: "Texas", milliPercent: 6250 },
  UT: { name: "Utah", milliPercent: 6100, statewideLocalMilli: 1250 },
  VT: { name: "Vermont", milliPercent: 6000 },
  VA: { name: "Virginia", milliPercent: 5300, statewideLocalMilli: 1000 },
  WA: { name: "Washington", milliPercent: 6500 },
  WV: { name: "West Virginia", milliPercent: 6000 },
  WI: { name: "Wisconsin", milliPercent: 5000 },
  WY: { name: "Wyoming", milliPercent: 4000 },
  DC: { name: "District of Columbia", milliPercent: 6000 },
};

/** 5.5% → "5.5%". 6.875% → "6.875%". */
export function formatTaxRate(milliPercent: number): string {
  const pct = milliPercent / 1000;
  const text = pct.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return `${text}%`;
}

/**
 * Ranking-only haircut when listing state (and ZIP→state) is still unknown.
 * Uses the highest statewide base in this table (California 7.25%) so an
 * unknown-state car cannot outrank a peer taxed at any tabulated rate.
 * Never shown as the buyer’s sales-tax line; displayed profit stays
 * “before sales tax (state unknown)”.
 */
export const RANKING_UNKNOWN_STATE_TAX_MILLI = Math.max(
  ...Object.values(ROWS).map((row) => row.milliPercent),
);

export const RANKING_UNKNOWN_STATE_TAX_NOTE = `Ranking applies a ${formatTaxRate(RANKING_UNKNOWN_STATE_TAX_MILLI)} statewide-base haircut (highest rate in this table) when state is unknown so cars without tax do not outrank taxed peers. Source: ${STATE_SALES_TAX_SOURCE_LABEL} as of ${STATE_SALES_TAX_AS_OF}. Not a quoted tax.`;

export function stateSalesTax(code: string | null | undefined): StateSalesTax | null {
  if (!code) return null;
  const row = ROWS[code.trim().toUpperCase()];
  if (!row) return null;
  return {
    code: code.trim().toUpperCase(),
    name: row.name,
    milliPercent: row.milliPercent,
    statewideLocalMilli: row.statewideLocalMilli ?? null,
  };
}

/** Whole dollars of state base tax. Does not add local rates. */
export function stateBaseTaxUsd(priceUsd: number, milliPercent: number): number {
  return Math.round((priceUsd * milliPercent) / 100_000);
}
