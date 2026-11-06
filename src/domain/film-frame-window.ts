/** Sliding decode window around the scrub head (inclusive radius). */
export const FRAME_WINDOW_RADIUS = 12;

/** Frame indices that should stay decoded for a scrub head. */
export function framesInWindow(center: number, count: number, radius = FRAME_WINDOW_RADIUS): number[] {
  if (count <= 0) return [];
  const clamped = Math.min(count - 1, Math.max(0, Math.round(center)));
  const start = Math.max(0, clamped - radius);
  const end = Math.min(count - 1, clamped + radius);
  const frames: number[] = [];
  for (let index = start; index <= end; index += 1) frames.push(index);
  return frames;
}

/**
 * Prefer the exact target when decoded; otherwise the nearest decoded index.
 * Returns null when nothing is decoded yet.
 */
export function nearestDecodedFrame(target: number, decoded: ReadonlySet<number>): number | null {
  if (decoded.has(target)) return target;

  let best: number | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const index of decoded) {
    const dist = Math.abs(index - target);
    if (dist < bestDist || (dist === bestDist && (best === null || index < best))) {
      best = index;
      bestDist = dist;
    }
  }
  return best;
}
