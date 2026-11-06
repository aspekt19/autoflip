"use client";

import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useEffect, useRef } from "react";
import { FRAME_WINDOW_RADIUS, framesInWindow, nearestDecodedFrame } from "@/domain/film-frame-window";
import type { Mode } from "@/domain/types";

gsap.registerPlugin(ScrollTrigger);

/** Swap the clip by replacing public/frames and these counts. */
export const DESKTOP_FRAMES = 48;
export const MOBILE_FRAMES = 32;

export type FilmPhase = "open" | "detail";

type FrameFolder = "desktop-2560" | "mobile";

/** Source frames are 16:9 (2560×1440 desktop, 1280×720 mobile). */
const FRAME_ASPECT = 16 / 9;
const MAX_BACKING_WIDTH = 2560;

type CoverSize = {
  cssW: number;
  cssH: number;
  dpr: number;
  canvasW: number;
  canvasH: number;
  resizeW: number;
  resizeH: number;
};

function phaseFor(progress: number): FilmPhase {
  if (progress < 0.14) return "open";
  return "detail";
}

function frameSrc(folder: FrameFolder, index: number) {
  return `/frames/${folder}/f${String(index + 1).padStart(3, "0")}.webp`;
}

function coverSizeFor(cssW: number, cssH: number): CoverSize | null {
  if (cssW < 2 || cssH < 2) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let canvasW = Math.round(cssW * dpr);
  let canvasH = Math.round(cssH * dpr);
  if (canvasW > MAX_BACKING_WIDTH) {
    const scale = MAX_BACKING_WIDTH / canvasW;
    canvasW = MAX_BACKING_WIDTH;
    canvasH = Math.round(canvasH * scale);
  }
  const canvasRatio = canvasW / canvasH;
  let resizeW: number;
  let resizeH: number;
  if (FRAME_ASPECT > canvasRatio) {
    resizeH = canvasH;
    resizeW = Math.round(canvasH * FRAME_ASPECT);
  } else {
    resizeW = canvasW;
    resizeH = Math.round(canvasW / FRAME_ASPECT);
  }
  return { cssW, cssH, dpr, canvasW, canvasH, resizeW, resizeH };
}

function closeBitmap(value: ImageBitmap | HTMLImageElement | undefined) {
  if (!value) return;
  if (typeof ImageBitmap !== "undefined" && value instanceof ImageBitmap) {
    value.close();
    return;
  }
  if (value instanceof HTMLImageElement && value.src.startsWith("blob:")) {
    URL.revokeObjectURL(value.src);
  }
}

async function decodeFrameBitmap(
  url: string,
  resizeW: number,
  resizeH: number,
): Promise<ImageBitmap | HTMLImageElement> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`frame fetch failed: ${response.status}`);
  const blob = await response.blob();

  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(blob, {
        resizeWidth: resizeW,
        resizeHeight: resizeH,
        resizeQuality: "high",
      });
    } catch {
      try {
        return await createImageBitmap(blob);
      } catch {
        // Fall through to Image + decode for Safari / older engines.
      }
    }
  }

  const objectUrl = URL.createObjectURL(blob);
  const image = new Image();
  image.decoding = "async";
  image.src = objectUrl;
  await image.decode();
  return image;
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  source: ImageBitmap | HTMLImageElement,
  size: CoverSize,
  shift: number,
) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, size.canvasW, size.canvasH);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  const srcW = "naturalWidth" in source ? source.naturalWidth : source.width;
  const srcH = "naturalHeight" in source ? source.naturalHeight : source.height;
  if (!srcW || !srcH) return;

  // Pre-resized ImageBitmaps already match cover size in device pixels — draw 1:1.
  const preSized =
    typeof ImageBitmap !== "undefined" &&
    source instanceof ImageBitmap &&
    Math.abs(srcW - size.resizeW) <= 1 &&
    Math.abs(srcH - size.resizeH) <= 1;

  let drawW: number;
  let drawH: number;
  if (preSized) {
    drawW = srcW;
    drawH = srcH;
  } else {
    const imageRatio = srcW / srcH;
    const canvasRatio = size.canvasW / size.canvasH;
    drawW = size.canvasW;
    drawH = size.canvasH;
    if (imageRatio > canvasRatio) drawW = size.canvasH * imageRatio;
    else drawH = size.canvasW / imageRatio;
  }

  const x = (size.canvasW - drawW) / 2 + shift * size.canvasW * 0.35;
  const y = (size.canvasH - drawH) / 2;
  ctx.drawImage(source, x, y, drawW, drawH);
}

/** Scroll-scrubbed film. The poster paints first. Frames decode off-thread into a sliding window. */
export function FilmScrub({ mode, onPhase }: { mode: Mode; onPhase: (phase: FilmPhase) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const index = useRef(0);
  const shift = useRef(0);
  const onPhaseRef = useRef(onPhase);
  const phaseRef = useRef<FilmPhase>("open");
  onPhaseRef.current = onPhase;

  // Mode-shift tween reads these; the main effect owns the real decode store.
  const paintBridge = useRef<{
    schedulePaint: () => void;
  } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const narrow = window.matchMedia("(max-width: 800px)").matches;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const count = narrow ? MOBILE_FRAMES : DESKTOP_FRAMES;
    const folder: FrameFolder = narrow ? "mobile" : "desktop-2560";

    const bitmaps: Array<ImageBitmap | HTMLImageElement | undefined> = Array.from({ length: count });
    const inflight = new Map<number, Promise<void>>();
    let generation = 0;
    let size = coverSizeFor(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight);
    let ctx = canvas.getContext("2d");
    let paintedFrame = -1;
    let paintedShift = Number.NaN;
    let raf = 0;
    let disposed = false;

    const syncCanvasSize = () => {
      if (!size || !ctx) return;
      if (canvas.width !== size.canvasW || canvas.height !== size.canvasH) {
        canvas.width = size.canvasW;
        canvas.height = size.canvasH;
        // Resetting canvas size drops context state; re-acquire once.
        ctx = canvas.getContext("2d");
      }
    };

    const decodedSet = () => {
      const set = new Set<number>();
      for (let frame = 0; frame < count; frame += 1) {
        if (bitmaps[frame]) set.add(frame);
      }
      return set;
    };

    const paintNow = () => {
      if (!ctx || !size) return;
      const target = index.current;
      const frame = nearestDecodedFrame(target, decodedSet());
      if (frame === null) return;
      const source = bitmaps[frame];
      if (!source) return;
      if (frame === paintedFrame && shift.current === paintedShift) return;
      syncCanvasSize();
      if (!ctx) return;
      drawCover(ctx, source, size, shift.current);
      paintedFrame = frame;
      paintedShift = shift.current;
    };

    const schedulePaint = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        paintNow();
      });
    };
    paintBridge.current = { schedulePaint };

    const releaseOutsideWindow = (center: number) => {
      const keep = new Set(framesInWindow(center, count, FRAME_WINDOW_RADIUS));
      for (let frame = 0; frame < count; frame += 1) {
        if (keep.has(frame)) continue;
        if (bitmaps[frame]) {
          closeBitmap(bitmaps[frame]);
          bitmaps[frame] = undefined;
        }
        inflight.delete(frame);
      }
    };

    const ensure = (frame: number) => {
      if (disposed || frame < 0 || frame >= count || !size) return;
      if (bitmaps[frame] || inflight.has(frame)) return;
      const gen = generation;
      const { resizeW, resizeH } = size;
      const task = decodeFrameBitmap(frameSrc(folder, frame), resizeW, resizeH)
        .then((bitmap) => {
          if (disposed || gen !== generation) {
            closeBitmap(bitmap);
            return;
          }
          const keep = new Set(framesInWindow(index.current, count, FRAME_WINDOW_RADIUS));
          if (!keep.has(frame)) {
            closeBitmap(bitmap);
            return;
          }
          closeBitmap(bitmaps[frame]);
          bitmaps[frame] = bitmap;
          if (nearestDecodedFrame(index.current, decodedSet()) === frame || frame === index.current) {
            schedulePaint();
          }
        })
        .catch(() => {
          /* leave slot empty; nearest decoded frame still paints */
        })
        .finally(() => {
          inflight.delete(frame);
        });
      inflight.set(frame, task);
    };

    const ensureWindow = (center: number) => {
      releaseOutsideWindow(center);
      for (const frame of framesInWindow(center, count, FRAME_WINDOW_RADIUS)) ensure(frame);
    };

    syncCanvasSize();
    // Progressive: every 4th in the opening window first, then fill the window.
    ensure(0);
    for (const frame of framesInWindow(0, count, FRAME_WINDOW_RADIUS)) {
      if (frame % 4 === 0) ensure(frame);
    }
    const fillHandle = window.setTimeout(() => {
      if (disposed) return;
      ensureWindow(index.current);
    }, 400);

    let resizeTimer = 0;
    const onResize = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (disposed) return;
        const next = coverSizeFor(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight);
        if (!next) return;
        const same =
          size &&
          size.canvasW === next.canvasW &&
          size.canvasH === next.canvasH &&
          size.resizeW === next.resizeW &&
          size.resizeH === next.resizeH;
        if (same) {
          schedulePaint();
          return;
        }
        generation += 1;
        size = next;
        for (let frame = 0; frame < count; frame += 1) {
          closeBitmap(bitmaps[frame]);
          bitmaps[frame] = undefined;
        }
        inflight.clear();
        paintedFrame = -1;
        paintedShift = Number.NaN;
        syncCanvasSize();
        ensureWindow(index.current);
        schedulePaint();
      }, 120);
    };
    window.addEventListener("resize", onResize);

    if (reduce) {
      return () => {
        disposed = true;
        paintBridge.current = null;
        window.removeEventListener("resize", onResize);
        window.clearTimeout(resizeTimer);
        window.clearTimeout(fillHandle);
        if (raf) window.cancelAnimationFrame(raf);
        for (const bitmap of bitmaps) closeBitmap(bitmap);
      };
    }

    const gsapCtx = gsap.context(() => {
      ScrollTrigger.create({
        trigger: ".film-pin",
        start: "top top",
        end: "bottom bottom",
        scrub: 0.6,
        onUpdate: (self) => {
          const next = Math.min(count - 1, Math.round(self.progress * (count - 1)));
          if (next !== index.current) {
            index.current = next;
            ensureWindow(next);
            schedulePaint();
          }
          const phase = phaseFor(self.progress);
          if (phase !== phaseRef.current) {
            phaseRef.current = phase;
            onPhaseRef.current(phase);
          }
        },
      });
    });

    return () => {
      disposed = true;
      paintBridge.current = null;
      window.removeEventListener("resize", onResize);
      window.clearTimeout(resizeTimer);
      window.clearTimeout(fillHandle);
      if (raf) window.cancelAnimationFrame(raf);
      for (const bitmap of bitmaps) closeBitmap(bitmap);
      gsapCtx.revert();
    };
  }, []);

  useEffect(() => {
    const target = mode === "flip" ? 0.03 : -0.015;
    const tween = gsap.to(shift, {
      current: target,
      duration: 0.7,
      ease: "power2.out",
      onUpdate: () => {
        paintBridge.current?.schedulePaint();
      },
    });
    return () => {
      tween.kill();
    };
  }, [mode]);

  return <canvas ref={canvasRef} className="film-canvas" />;
}
