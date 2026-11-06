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

  const creditLabel = credits === null ? "Report credits" : `${credits} report credit${credits === 1 ? "" : "s"}`;

  return (
    <header className="bar">
      <Link className="brand" href="/">
        <img src="/logo.svg" alt="" width={40} height={40} />
        <span className="brand-name">Lemonless</span>
      </Link>
      <button className="menu-btn" type="button" aria-expanded={menuOpen} aria-controls="primary-nav" onClick={() => setMenuOpen((open) => !open)}>
        Menu
      </button>
      <nav id="primary-nav" aria-label="Primary" className={menuOpen ? "nav-open" : undefined}>
        <Link href="/find" onClick={() => setMenuOpen(false)}>Find a car</Link>
        <Link href="/check" onClick={() => setMenuOpen(false)}>Check a car</Link>
        <Link href="/radar" onClick={() => setMenuOpen(false)}>Price alerts</Link>
        <Link href="/reports" onClick={() => setMenuOpen(false)}>Reports</Link>
        <Link href="/favorites" onClick={() => setMenuOpen(false)}>Saved cars</Link>
        <Link href="/compare-cars" onClick={() => setMenuOpen(false)}>Compare cars</Link>
        <Link href="/pricing" onClick={() => setMenuOpen(false)}>Pricing</Link>
        <Link className="nav-go" href="/credits">
          {creditLabel}
        </Link>
      </nav>
    </header>
  );
}
