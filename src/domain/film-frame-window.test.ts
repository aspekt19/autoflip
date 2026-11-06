import { describe, expect, it } from "vitest";
import {
  decodeOrder,
  frameIndexForProgress,
  nearestDecodedFrame,
  paintedSequenceForTargets,
} from "./film-frame-window";

describe("film frame scrub helpers", () => {
  it("maps progress to the same indices both directions", () => {
    expect(frameIndexForProgress(0, 48)).toBe(0);
    expect(frameIndexForProgress(1, 48)).toBe(47);
    expect(frameIndexForProgress(0.5, 48)).toBe(24);
    const down = Array.from({ length: 48 }, (_, step) => frameIndexForProgress(step / 47, 48));
    const up = Array.from({ length: 48 }, (_, step) => frameIndexForProgress(1 - step / 47, 48));
    expect(down).toEqual(Array.from({ length: 48 }, (_, index) => index));
    expect(up).toEqual(Array.from({ length: 48 }, (_, index) => 47 - index));
  });

  it("orders decode as frame 0, every 4th, then fill", () => {
    expect(decodeOrder(10)).toEqual([0, 4, 8, 1, 2, 3, 5, 6, 7, 9]);
    expect(decodeOrder(48)[0]).toBe(0);
    expect(new Set(decodeOrder(48)).size).toBe(48);
  });

  it("picks the nearest decoded frame when the target is still loading", () => {
    expect(nearestDecodedFrame(10, new Set([10]))).toBe(10);
    expect(nearestDecodedFrame(10, new Set([8, 12]))).toBe(8);
    expect(nearestDecodedFrame(11, new Set([8, 12]))).toBe(12);
    expect(nearestDecodedFrame(3, new Set())).toBeNull();
  });

  it("paints exact frames when scrubbing reverse 47→0 with all decoded", () => {
    const all = new Set(Array.from({ length: 48 }, (_, index) => index));
    const targets = Array.from({ length: 48 }, (_, index) => 47 - index);
    expect(paintedSequenceForTargets(targets, all)).toEqual(targets);
  });
});
