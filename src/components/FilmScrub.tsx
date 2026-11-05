"use client";

import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useEffect, useRef } from "react";
import type { Mode } from "@/domain/types";

gsap.registerPlugin(ScrollTrigger);

/** Swap the clip by replacing public/frames and these counts. */
export const DESKTOP_FRAMES = 48;
export const MOBILE_FRAMES = 32;

export type FilmPhase = "open" | "detail";

function phaseFor(progress: number): FilmPhase {
  if (progress < 0.14) return "open";
  return "detail";
}

function frameSrc(folder: "desktop" | "mobile", index: number) {
  return `/frames/${folder}/f${String(index + 1).padStart(3, "0")}.webp`;
}

function drawCover(canvas: HTMLCanvasElement, image: HTMLImageElement, shift: number) {
  const ctx = canvas.getContext("2d");
  if (!ctx || !image.naturalWidth) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width < 2 || height < 2) return;
  const nextW = Math.round(width * dpr);
  const nextH = Math.round(height * dpr);
  if (canvas.width !== nextW || canvas.height !== nextH) {
    canvas.width = nextW;
    canvas.height = nextH;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const imageRatio = image.naturalWidth / image.naturalHeight;
  const canvasRatio = width / height;
  let drawW = width;
  let drawH = height;
  if (imageRatio > canvasRatio) drawW = height * imageRatio;
  else drawH = width / imageRatio;
  const x = (width - drawW) / 2 + shift * width * 0.35;
  const y = (height - drawH) / 2;
  ctx.drawImage(image, x, y, drawW, drawH);
}

/** Scroll-scrubbed film. The poster paints first. Later frames load as the scroll approaches them. */
export function FilmScrub({ mode, onPhase }: { mode: Mode; onPhase: (phase: FilmPhase) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const images = useRef<Array<HTMLImageElement | undefined>>([]);
  const index = useRef(0);
  const shift = useRef(0);
  const onPhaseRef = useRef(onPhase);
  const phaseRef = useRef<FilmPhase>("open");
  onPhaseRef.current = onPhase;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const narrow = window.matchMedia("(max-width: 800px)").matches;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const count = narrow ? MOBILE_FRAMES : DESKTOP_FRAMES;
    const folder = narrow ? "mobile" : "desktop";
    images.current = Array.from({ length: count });

    const paint = (frame: number) => {
      const image = images.current[frame];
      if (image?.complete && image.naturalWidth) drawCover(canvas, image, shift.current);
    };

    const ensure = (frame: number) => {
      if (frame < 0 || frame >= count) return;
      const existing = images.current[frame];
      if (existing) return;
      const image = new Image();
      image.decoding = "async";
      image.src = frameSrc(folder, frame);
      images.current[frame] = image;
      image.onload = () => {
        if (index.current === frame) paint(frame);
      };
    };

    const around = (frame: number) => {
      ensure(frame);
      for (let step = 1; step <= 8; step += 1) ensure(frame + step);
      ensure(frame - 1);
    };

    around(0);
    const idleHandle = window.setTimeout(() => {
      for (let frame = 0; frame < count; frame += 16) ensure(frame);
    }, 400);

    const onResize = () => paint(index.current);
    window.addEventListener("resize", onResize);

    if (reduce) {
      return () => {
        window.removeEventListener("resize", onResize);
        window.clearTimeout(idleHandle);
      };
    }

    const ctx = gsap.context(() => {
      ScrollTrigger.create({
        trigger: ".film-pin",
        start: "top top",
        end: "bottom bottom",
        scrub: 0.6,
        onUpdate: (self) => {
          const next = Math.min(count - 1, Math.round(self.progress * (count - 1)));
          index.current = next;
          around(next);
          paint(next);
          const phase = phaseFor(self.progress);
          if (phase !== phaseRef.current) {
            phaseRef.current = phase;
            onPhaseRef.current(phase);
          }
        },
      });
    });
    return () => {
      window.removeEventListener("resize", onResize);
      window.clearTimeout(idleHandle);
      ctx.revert();
    };
  }, []);

  useEffect(() => {
    const target = mode === "flip" ? 0.03 : -0.015;
    const tween = gsap.to(shift, {
      current: target,
      duration: 0.7,
      ease: "power2.out",
      onUpdate: () => {
        const canvas = canvasRef.current;
        const image = images.current[index.current];
        if (canvas && image?.complete) drawCover(canvas, image, shift.current);
      },
    });
    return () => {
      tween.kill();
    };
  }, [mode]);

  return <canvas ref={canvasRef} className="film-canvas" />;
}
