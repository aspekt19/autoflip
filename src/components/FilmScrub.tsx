"use client";

import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useEffect, useRef } from "react";
import type { Mode } from "@/domain/types";

gsap.registerPlugin(ScrollTrigger);

/** Swap the clip by replacing public/frames and these counts. Current clip is Mixkit 50. */
const DESKTOP_FRAMES = 102;
const MOBILE_FRAMES = 68;

function drawCover(
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  shift: number,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx || !image.naturalWidth) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
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
  const x = (width - drawW) / 2 + shift * width;
  const y = (height - drawH) / 2;
  ctx.fillStyle = "#050505";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(image, x, y, drawW, drawH);
}

/** Apple-style frame scrub. Desktop and phone both move; the phone uses fewer, smaller frames. */
export function FilmScrub({ mode }: { mode: Mode }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const images = useRef<HTMLImageElement[]>([]);
  const index = useRef(0);
  const shift = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const narrow = window.matchMedia("(max-width: 800px)").matches;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const count = narrow ? MOBILE_FRAMES : DESKTOP_FRAMES;
    const folder = narrow ? "mobile" : "desktop";
    const frames = Array.from({ length: count }, (_, i) => {
      const image = new Image();
      image.decoding = "async";
      image.src = `/frames/${folder}/f${String(i + 1).padStart(3, "0")}.webp`;
      image.onload = () => {
        if (i === index.current) drawCover(canvas, image, shift.current);
      };
      return image;
    });
    images.current = frames;

    const paint = (frame: number) => {
      const image = frames[frame];
      if (image) drawCover(canvas, image, shift.current);
    };
    const onResize = () => paint(index.current);
    window.addEventListener("resize", onResize);

    if (reduce) {
      index.current = 0;
      return () => window.removeEventListener("resize", onResize);
    }

    const ctx = gsap.context(() => {
      ScrollTrigger.create({
        trigger: ".film-pin",
        start: "top top",
        end: "bottom bottom",
        scrub: 0.45,
        onUpdate: (self) => {
          const next = Math.min(count - 1, Math.round(self.progress * (count - 1)));
          index.current = next;
          paint(next);
        },
      });
    });
    return () => {
      window.removeEventListener("resize", onResize);
      ctx.revert();
    };
  }, []);

  useEffect(() => {
    const target = mode === "flip" ? 0.035 : -0.02;
    const tween = gsap.to(shift, {
      current: target,
      duration: 0.7,
      ease: "power2.out",
      onUpdate: () => {
        const canvas = canvasRef.current;
        const image = images.current[index.current];
        if (canvas && image) drawCover(canvas, image, shift.current);
      },
    });
    return () => {
      tween.kill();
    };
  }, [mode]);

  return <canvas ref={canvasRef} className="film-canvas" />;
}
