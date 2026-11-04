export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1]! + sorted[mid]!) / 2;
  return sorted[mid]!;
}

export function percentileValue(values: number[], percentile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (percentile <= 0) return sorted[0]!;
  if (percentile >= 100) return sorted[sorted.length - 1]!;
  const rank = (percentile / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low]!;
  const weight = rank - low;
  return sorted[low]! * (1 - weight) + sorted[high]! * weight;
}

/** Percent of the sample at or below `value`, with ties split. 0–100. */
export function percentileRank(value: number, sample: number[]): number | null {
  if (sample.length === 0) return null;
  const below = sample.filter((item) => item < value).length;
  const equal = sample.filter((item) => item === value).length;
  return ((below + equal * 0.5) / sample.length) * 100;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function roundDollars(value: number): number {
  return Math.round(value);
}
