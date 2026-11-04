"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

export function Header() {
  const pathname = usePathname();
  const [credits, setCredits] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/account")
      .then((response) => response.json())
      .then((body: { credits?: number }) => {
        if (!cancelled && typeof body.credits === "number") setCredits(body.credits);
      })
      .catch(() => {
        if (!cancelled) setCredits(null);
      });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  const creditLabel = credits === null ? "Credits" : `${credits} credit${credits === 1 ? "" : "s"}`;

  return (
    <header className="bar">
      <Link className="brand" href="/">
        <img src="/logo.svg" alt="" width={40} height={40} />
        <span className="brand-name">AutoFlip</span>
      </Link>
      <nav aria-label="Primary">
        <Link href="/radar">Deal Radar</Link>
        <Link href="/developers">Developers</Link>
        <Link className="nav-go" href="/credits">
          {creditLabel}
        </Link>
      </nav>
    </header>
  );
}
