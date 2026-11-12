import type { SaleSpeed } from "./flip-rank";

/** Listing age above this is not a days-to-sell estimate. */
export const DAYS_TO_SELL_UNUSABLE_AFTER = 120;

/**
 * Days to sell is a stand-in from how long this listing has already been up.
 * It is not a count of closed sales. An age past the usable cap stays unknown.
 */
export function daysToSellEstimate(input: {
  speed: SaleSpeed;
  listingAgeDays: number | null;
}): { days: number | null; basis: string } {
  const age = input.listingAgeDays;
  if (age != null && age > DAYS_TO_SELL_UNUSABLE_AFTER) {
    return {
      days: null,
      basis: `Days to sell: unknown. This listing has been up about ${age} days, which is too long to use as a days-to-sell estimate. We do not have sold-car timing.`,
    };
  }
  if (age == null && input.speed === "unknown") {
    return {
      days: null,
      basis: "Estimated days to sell: unknown. Listing age was not in the feed and there is no sold-car timing for this car.",
    };
  }
  if (input.speed === "faster") {
    const days = age != null ? Math.max(7, age) : 14;
    return {
      days,
      basis: `Estimated days to sell: about ${days}. This uses how long the listing has been up, not how long similar cars took to sell.`,
    };
  }
  if (input.speed === "slower") {
    const days = age != null ? Math.max(45, age) : 60;
    return {
      days,
      basis: `Estimated days to sell: about ${days}. This uses how long the listing has been up, not how long similar cars took to sell.`,
    };
  }
  if (input.speed === "typical") {
    const days = age != null ? Math.max(21, age) : 30;
    return {
      days,
      basis: `Estimated days to sell: about ${days}. This uses how long the listing has been up, not how long similar cars took to sell.`,
    };
  }
  return {
    days: null,
    basis: "Estimated days to sell: unknown.",
  };
}
