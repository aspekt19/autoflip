"use client";

import { useLayoutEffect, useRef, useState } from "react";

const MARQUEE_ITEMS = [
  "For me",
  "For resale",
  "Price badge",
  "Mileage",
  "Full analysis",
  "For agents",
] as const;

/**
 * Edge-to-edge ticker: two identical groups, each ≥ viewport width, animate
 * translateX(0 → −50%) with no initial offset. Reduced-motion: static fill.
 */
export function HomeMarquee() {
  const stripRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [copies, setCopies] = useState(2);

  useLayoutEffect(() => {
    const strip = stripRef.current;
    const measure = measureRef.current;
    if (!strip || !measure) return;

    const update = () => {
      const stripW = strip.clientWidth;
      const oneSetW = measure.scrollWidth;
      if (stripW <= 0 || oneSetW <= 0) return;
      // Each half must cover ≥ viewport so frame 0 has no empty left gap.
      const need = Math.max(2, Math.ceil(stripW / oneSetW) + 1);
      setCopies((prev) => (prev === need ? prev : need));
    };

    update();
    const ro = new ResizeObserver(update);
    ro.observe(strip);
    return () => ro.disconnect();
  }, []);

  const half = Array.from({ length: copies }, () => MARQUEE_ITEMS).flat();

  return (
    <div className="marquee" aria-hidden="true" ref={stripRef} data-testid="home-marquee">
      {/* Off-DOM measure of one item set (gap matches .marquee-group). */}
      <div className="marquee-measure" ref={measureRef}>
        {MARQUEE_ITEMS.map((label) => (
          <span key={`m-${label}`}>{label}</span>
        ))}
      </div>
      <div className="marquee-track" data-testid="home-marquee-track">
        <div className="marquee-group">
          {half.map((label, i) => (
            <span key={`a-${i}-${label}`}>{label}</span>
          ))}
        </div>
        <div className="marquee-group">
          {half.map((label, i) => (
            <span key={`b-${i}-${label}`}>{label}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
