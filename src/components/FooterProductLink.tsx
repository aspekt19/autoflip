"use client";

import { useEffect, useState } from "react";
import type { ProductFlags } from "@/domain/product-flags";

/**
 * Footer twin of the header product link.
 * Deal Radar is shown when GET /api/product-flags says it is on (default ON).
 * Resale is the default so a hidden radar route is never a footer link.
 */
export function FooterProductLink() {
  const [flags, setFlags] = useState<ProductFlags | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/product-flags")
      .then((response) => response.json())
      .then((body: { flags?: ProductFlags }) => {
        if (!cancelled && body.flags) setFlags(body.flags);
      })
      .catch(() => {
        if (!cancelled) setFlags(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (flags?.dealRadar === true) return <a href="/radar">Deal Radar</a>;
  if (flags == null || flags.resaleEvaluate) return <a href="/resale">Resale</a>;
  return null;
}
