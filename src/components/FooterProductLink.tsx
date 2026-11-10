"use client";

import { useEffect, useState } from "react";
import type { ProductFlags } from "@/domain/product-flags";

/**
 * Footer twin of the header product links.
 * Resale stays when evaluate is on; Deal Radar sits next to it when enabled.
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

  const resale = flags == null || flags.resaleEvaluate;
  const radar = flags?.dealRadar === true;
  if (!resale && !radar) return null;
  return (
    <>
      {resale ? <a href="/resale">Resale</a> : null}
      {radar ? <a href="/radar">Deal Radar</a> : null}
    </>
  );
}
