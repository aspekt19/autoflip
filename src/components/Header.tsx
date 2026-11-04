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

  return (
    <header className="site-header">
      <div className="header-inner">
        <Link className="brand" href="/">
          <img src="/logo.svg" alt="" width={28} height={28} />
          AutoFlip
        </Link>
        <nav className="nav" aria-label="Primary">
          <Link href="/radar">Deal Radar</Link>
          <Link href="/credits">Credits</Link>
          <Link href="/developers">Developers</Link>
          <span className="credit-pill">{credits === null ? "…" : `${credits} credit${credits === 1 ? "" : "s"}`}</span>
        </nav>
      </div>
    </header>
  );
}
