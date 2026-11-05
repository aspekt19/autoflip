"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

export function Header() {
  const pathname = usePathname();
  const [credits, setCredits] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

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
      <button className="menu-btn" type="button" aria-expanded={menuOpen} aria-controls="primary-nav" onClick={() => setMenuOpen((open) => !open)}>
        Menu
      </button>
      <nav id="primary-nav" aria-label="Primary" className={menuOpen ? "nav-open" : undefined}>
        <Link href="/find" onClick={() => setMenuOpen(false)}>Find</Link>
        <Link href="/check" onClick={() => setMenuOpen(false)}>Check by VIN</Link>
        <Link href="/radar" onClick={() => setMenuOpen(false)}>Deal Radar</Link>
        <Link href="/pricing" onClick={() => setMenuOpen(false)}>Pricing</Link>
        <Link href="/developers" onClick={() => setMenuOpen(false)}>For agents</Link>
        <Link className="nav-go" href="/credits">
          {creditLabel}
        </Link>
      </nav>
    </header>
  );
}
