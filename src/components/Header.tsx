"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { BrandLockup } from "./BrandLockup";

const NAV_LINKS = [
  { href: "/find", label: "Find a car" },
  { href: "/check", label: "Check a car" },
  { href: "/radar", label: "Deal Radar" },
  { href: "/reports", label: "Reports" },
  { href: "/favorites", label: "Saved cars" },
  { href: "/compare-cars", label: "Compare cars" },
  { href: "/pricing", label: "Pricing" },
] as const;

export function Header() {
  const pathname = usePathname();
  const [credits, setCredits] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const navId = useId();

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

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" || event.key === "Esc") {
        event.preventDefault();
        setMenuOpen(false);
        queueMicrotask(() => menuBtnRef.current?.focus());
      }
    }
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node | null;
      if (!target) return;
      if (navRef.current?.contains(target) || menuBtnRef.current?.contains(target)) return;
      setMenuOpen(false);
    }
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [menuOpen]);

  const creditLabel = credits === null ? "Report credits" : `${credits} report credit${credits === 1 ? "" : "s"}`;

  return (
    <header className="bar">
      <BrandLockup size={40} animated className="brand" surface="dark" />
      <nav id={navId} ref={navRef} aria-label="Primary" className={menuOpen ? "nav-open" : undefined}>
        {NAV_LINKS.map((item) => (
          <Link key={item.href} href={item.href} onClick={() => setMenuOpen(false)}>
            {item.label}
          </Link>
        ))}
        <Link className="nav-go" href="/credits" onClick={() => setMenuOpen(false)}>
          {creditLabel}
        </Link>
      </nav>
      <button
        ref={menuBtnRef}
        className="menu-btn"
        type="button"
        aria-expanded={menuOpen}
        aria-controls={navId}
        aria-label={menuOpen ? "Close menu" : "Open menu"}
        onClick={() => setMenuOpen((open) => !open)}
      >
        {menuOpen ? "Close" : "Menu"}
      </button>
    </header>
  );
}
