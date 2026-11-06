import { describe, expect, it } from "vitest";
import { FRAME_WINDOW_RADIUS, framesInWindow, nearestDecodedFrame } from "./film-frame-window";

describe("film frame window", () => {
  it("keeps a sliding window of ±radius around the scrub head", () => {
    expect(framesInWindow(0, 48)).toEqual(
      Array.from({ length: FRAME_WINDOW_RADIUS + 1 }, (_, index) => index),
    );
    expect(framesInWindow(24, 48)).toEqual(
      Array.from({ length: FRAME_WINDOW_RADIUS * 2 + 1 }, (_, index) => 24 - FRAME_WINDOW_RADIUS + index),
    );
    expect(framesInWindow(47, 48).at(-1)).toBe(47);
    expect(framesInWindow(47, 48)[0]).toBe(47 - FRAME_WINDOW_RADIUS);
  });

  it("picks the nearest decoded frame when the target is still loading", () => {
    expect(nearestDecodedFrame(10, new Set([10]))).toBe(10);
    expect(nearestDecodedFrame(10, new Set([8, 12]))).toBe(8);
    expect(nearestDecodedFrame(11, new Set([8, 12]))).toBe(12);
    expect(nearestDecodedFrame(5, new Set([0, 2]))).toBe(2);
    expect(nearestDecodedFrame(3, new Set())).toBeNull();
  });
});
