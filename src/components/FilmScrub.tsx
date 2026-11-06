"use client";

import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useEffect, useRef } from "react";
import {
  decodeOrder,
  frameIndexForProgress,
  MAX_DECODE_WIDTH,
  nearestDecodedFrame,
} from "@/domain/film-frame-window";
import type { Mode } from "@/domain/types";

gsap.registerPlugin(ScrollTrigger);

/** Swap the clip by replacing public/frames and these counts. */
export const DESKTOP_FRAMES = 48;
export const MOBILE_FRAMES = 32;

export type FilmPhase = "open" | "detail";

type FrameFolder = "desktop-2560" | "mobile";

/** Source frames are 16:9 (2560×1440 desktop, 1280×720 mobile). */
const FRAME_ASPECT = 16 / 9;
const DECODE_CONCURRENCY = 3;

type CoverSize = {
  cssW: number;
  cssH: number;
  dpr: number;
  canvasW: number;
  canvasH: number;
  resizeW: number;
  resizeH: number;
};

export type FilmScrubDebug = {
  getIndex: () => number;
  getPainted: () => number;
  getDecodedCount: () => number;
  isFullyDecoded: () => boolean;
  count: number;
  waitUntilDecoded: (timeoutMs?: number) => Promise<boolean>;
};

declare global {
  interface Window {
    __filmScrubDebug?: FilmScrubDebug;
  }
}

function phaseFor(progress: number): FilmPhase {
  if (progress < 0.14) return "open";
  return "detail";
}

function frameSrc(folder: FrameFolder, index: number) {
  return `/frames/${folder}/f${String(index + 1).padStart(3, "0")}.webp`;
}

/** Cover size in device pixels; decoded bitmap width capped at MAX_DECODE_WIDTH (~450 MB for 48 frames). */
export function coverSizeFor(cssW: number, cssH: number, devicePixelRatio = 1): CoverSize | null {
  if (cssW < 2 || cssH < 2) return null;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  let canvasW = Math.round(cssW * dpr);
  let canvasH = Math.round(cssH * dpr);
  if (canvasW > MAX_DECODE_WIDTH) {
    const scale = MAX_DECODE_WIDTH / canvasW;
    canvasW = MAX_DECODE_WIDTH;
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
  if (resizeW > MAX_DECODE_WIDTH) {
    const scale = MAX_DECODE_WIDTH / resizeW;
    resizeW = MAX_DECODE_WIDTH;
    resizeH = Math.round(resizeH * scale);
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

async function decodeBlobToBitmap(
  blob: Blob,
  resizeW: number,
  resizeH: number,
): Promise<ImageBitmap | HTMLImageElement> {
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

  const imageRatio = srcW / srcH;
  const canvasRatio = size.canvasW / size.canvasH;
  let drawW = size.canvasW;
  let drawH = size.canvasH;
  if (imageRatio > canvasRatio) drawW = size.canvasH * imageRatio;
  else drawH = size.canvasW / imageRatio;

  const x = (size.canvasW - drawW) / 2 + shift * size.canvasW * 0.35;
  const y = (size.canvasH - drawH) / 2;
  ctx.drawImage(source, x, y, drawW, drawH);
}

/** Scroll-scrubbed film. Poster paints first; all frames fetch once and stay decoded. */
export function FilmScrub({ mode, onPhase }: { mode: Mode; onPhase: (phase: FilmPhase) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const index = useRef(0);
  const shift = useRef(0);
  const onPhaseRef = useRef(onPhase);
  const phaseRef = useRef<FilmPhase>("open");
  onPhaseRef.current = onPhase;

  const paintBridge = useRef<{ schedulePaint: () => void } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const narrow = window.matchMedia("(max-width: 800px)").matches;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const count = narrow ? MOBILE_FRAMES : DESKTOP_FRAMES;
    const folder: FrameFolder = narrow ? "mobile" : "desktop-2560";

    const blobs: Array<Blob | undefined> = Array.from({ length: count });
    const bitmaps: Array<ImageBitmap | HTMLImageElement | undefined> = Array.from({ length: count });
    const inflight = new Map<number, Promise<void>>();
    let generation = 0;
    let size = coverSizeFor(
      canvas.clientWidth || window.innerWidth,
      canvas.clientHeight || window.innerHeight,
      window.devicePixelRatio || 1,
    );
    let ctx = canvas.getContext("2d");
    let paintedFrame = -1;
    let paintedShift = Number.NaN;
    let raf = 0;
    let disposed = false;
    let decodeDone: Promise<void> = Promise.resolve();

    const syncCanvasSize = () => {
      if (!size || !ctx) return;
      if (canvas.width !== size.canvasW || canvas.height !== size.canvasH) {
        canvas.width = size.canvasW;
        canvas.height = size.canvasH;
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

    const fetchAllBlobs = async () => {
      await Promise.all(
        Array.from({ length: count }, async (_, frame) => {
          if (disposed) return;
          const response = await fetch(frameSrc(folder, frame));
          if (!response.ok) throw new Error(`frame fetch failed: ${response.status}`);
          blobs[frame] = await response.blob();
        }),
      );
    };

    const decodeOne = (frame: number, gen: number) => {
      if (disposed || frame < 0 || frame >= count || !size) return Promise.resolve();
      if (bitmaps[frame]) return Promise.resolve();
      const existing = inflight.get(frame);
      if (existing) return existing;
      const blob = blobs[frame];
      if (!blob) return Promise.resolve();
      const { resizeW, resizeH } = size;
      const task = decodeBlobToBitmap(blob, resizeW, resizeH)
        .then((bitmap) => {
          if (disposed || gen !== generation) {
            closeBitmap(bitmap);
            return;
          }
          closeBitmap(bitmaps[frame]);
          bitmaps[frame] = bitmap;
          if (frame === index.current || nearestDecodedFrame(index.current, decodedSet()) === frame) {
            schedulePaint();
          }
        })
        .catch(() => {
          /* leave slot empty; nearest decoded still paints */
        })
        .finally(() => {
          inflight.delete(frame);
        });
      inflight.set(frame, task);
      return task;
    };

    const decodeAll = async (gen: number) => {
      if (!size) return;
      const order = decodeOrder(count);
      let cursor = 0;
      const worker = async () => {
        while (!disposed && gen === generation && cursor < order.length) {
          const frame = order[cursor];
          cursor += 1;
          await decodeOne(frame, gen);
        }
      };
      await Promise.all(Array.from({ length: DECODE_CONCURRENCY }, () => worker()));
    };

    const boot = async () => {
      syncCanvasSize();
      try {
        await fetchAllBlobs();
      } catch {
        return;
      }
      if (disposed) return;
      // Decode frame 0 immediately for first paint, then background-fill the rest.
      await decodeOne(0, generation);
      schedulePaint();
      decodeDone = decodeAll(generation);
      await decodeDone;
    };

    decodeDone = boot();

    window.__filmScrubDebug = {
      getIndex: () => index.current,
      getPainted: () => paintedFrame,
      getDecodedCount: () => bitmaps.filter(Boolean).length,
      isFullyDecoded: () => bitmaps.every(Boolean),
      count,
      waitUntilDecoded: async (timeoutMs = 60_000) => {
        const start = performance.now();
        while (!disposed && !bitmaps.every(Boolean) && performance.now() - start < timeoutMs) {
          await decodeDone.catch(() => undefined);
          if (bitmaps.every(Boolean)) return true;
          await new Promise((resolve) => window.setTimeout(resolve, 50));
        }
        return bitmaps.every(Boolean);
      },
    };

    let resizeTimer = 0;
    const onResize = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (disposed) return;
        const next = coverSizeFor(
          canvas.clientWidth || window.innerWidth,
          canvas.clientHeight || window.innerHeight,
          window.devicePixelRatio || 1,
        );
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
        // Re-decode from cached blobs — never re-fetch.
        decodeDone = decodeAll(generation);
        schedulePaint();
      }, 120);
    };
    window.addEventListener("resize", onResize);

    if (reduce) {
      return () => {
        disposed = true;
        paintBridge.current = null;
        delete window.__filmScrubDebug;
        window.removeEventListener("resize", onResize);
        window.clearTimeout(resizeTimer);
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
          const next = frameIndexForProgress(self.progress, count);
          if (next !== index.current) {
            index.current = next;
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
      delete window.__filmScrubDebug;
      window.removeEventListener("resize", onResize);
      window.clearTimeout(resizeTimer);
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
