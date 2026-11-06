/** Cap decoded bitmap width so 48 RGBA frames stay under ~450 MB. */
export const MAX_DECODE_WIDTH = 2048;

/** Map scrub progress (0–1) to a frame index. Same formula both directions. */
export function frameIndexForProgress(progress: number, count: number): number {
  if (count <= 0) return 0;
  const clamped = Math.min(1, Math.max(0, progress));
  return Math.min(count - 1, Math.round(clamped * (count - 1)));
}

/**
 * Decode order: frame 0, then every 4th, then fill remaining.
 * Keeps early scrub responsive while the rest fills in the background.
 */
export function decodeOrder(count: number): number[] {
  const order: number[] = [];
  const seen = new Set<number>();
  const push = (index: number) => {
    if (index < 0 || index >= count || seen.has(index)) return;
    seen.add(index);
    order.push(index);
  };
  push(0);
  for (let index = 0; index < count; index += 4) push(index);
  for (let index = 0; index < count; index += 1) push(index);
  return order;
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

/** Simulated paint sequence for a list of target indices (e.g. 47→0). */
export function paintedSequenceForTargets(
  targets: readonly number[],
  decoded: ReadonlySet<number>,
): Array<number | null> {
  return targets.map((target) => nearestDecodedFrame(target, decoded));
}
