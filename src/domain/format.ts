const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const usdExact = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const num = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function formatUsd(value: number): string {
  return usd.format(value);
}

export function formatUsdExact(value: number): string {
  return usdExact.format(value);
}

export function formatNumber(value: number): string {
  return num.format(value);
}

export function formatPct(ratio: number, digits = 1): string {
  const points = ratio * 100;
  const fixed = points.toFixed(digits);
  const trimmed = fixed.replace(/\.0$/, "");
  return `${trimmed}%`;
}

export function verdictLabel(verdict: string): string {
  switch (verdict) {
    case "good_deal":
      return "Good deal";
    case "fair":
      return "Fair";
    case "overpriced":
      return "Overpriced";
    case "walk_away":
      return "Walk away";
    case "insufficient_data":
      return "Not enough data";
    default:
      return verdict;
  }
}
