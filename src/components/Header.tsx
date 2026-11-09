"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { CREDIT_BALANCE_EVENT } from "@/domain/credit-balance-event";
import { BrandLockup } from "./BrandLockup";
import { headerAuthControl } from "./header-auth";

const BASE_NAV_LINKS = [
  { href: "/find", label: "Find a car" },
  { href: "/check", label: "Check a car" },
  { href: "/radar", label: "Deal Radar" },
  { href: "/reports", label: "Reports" },
  { href: "/favorites", label: "Saved cars" },
  { href: "/compare-cars", label: "Compare cars" },
  { href: "/pricing", label: "Pricing" },
] as const;

/**
 * Primary nav. Scout link visibility follows runtime SCOUT_UI_ENABLED via
 * GET /api/scout capabilities — never a build-time bake of the flag (static
 * home must not omit Scout when the deploy later enables the UI).
 */
export function Header({ scoutNavEnabled = false }: { scoutNavEnabled?: boolean }) {
  const pathname = usePathname();
  const [credits, setCredits] = useState<number | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [accountEmail, setAccountEmail] = useState<string | null>(null);
  /** undefined until /api/account answers; false means providers are off. */
  const [authConfigured, setAuthConfigured] = useState<boolean | undefined>(undefined);
  /** null = not yet known; prefer runtime capabilities over build-time prop. */
  const [scoutUiRuntime, setScoutUiRuntime] = useState<boolean | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const navId = useId();
  const showScout = scoutUiRuntime ?? scoutNavEnabled;
  const navLinks = showScout
    ? [...BASE_NAV_LINKS.slice(0, 3), { href: "/scout", label: "Scout" }, ...BASE_NAV_LINKS.slice(3)]
    : [...BASE_NAV_LINKS];

  useEffect(() => {
    function onBalance(event: Event) {
      const detail = (event as CustomEvent<number>).detail;
      if (typeof detail === "number" && Number.isFinite(detail)) setCredits(detail);
    }
    window.addEventListener(CREDIT_BALANCE_EVENT, onBalance);
    return () => window.removeEventListener(CREDIT_BALANCE_EVENT, onBalance);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/account")
      .then((response) => response.json())
      .then((body: { credits?: number; authenticated?: boolean; email?: string | null; auth?: { configured?: boolean } }) => {
        if (cancelled) return;
        if (typeof body.credits === "number") setCredits(body.credits);
        setSignedIn(Boolean(body.authenticated));
        setAccountEmail(typeof body.email === "string" ? body.email : null);
        setAuthConfigured(Boolean(body.auth?.configured));
      })
      .catch(() => {
        if (!cancelled) setCredits(null);
      });
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/scout")
      .then((response) => response.json())
      .then((body: { capabilities?: { uiEnabled?: boolean } }) => {
        if (!cancelled) setScoutUiRuntime(Boolean(body.capabilities?.uiEnabled));
      })
      .catch(() => {
        // Leave null so build-time prop remains a last-resort hint; never invent true.
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
  const account = headerAuthControl({
    authenticated: signedIn,
    email: accountEmail,
    pathname,
    authConfigured,
  });

  return (
    <header className="bar">
      <BrandLockup size={58} animated className="brand" surface="dark" />
      <nav id={navId} ref={navRef} aria-label="Primary" className={menuOpen ? "nav-open" : undefined}>
        {navLinks.map((item) => (
          <Link key={item.href} href={item.href} onClick={() => setMenuOpen(false)}>
            {item.label}
          </Link>
        ))}
        <Link className="nav-go" href="/credits" onClick={() => setMenuOpen(false)}>
          <span className="nav-go-full">{creditLabel}</span>
          <span className="nav-go-short">{credits === null ? "Credits" : `${credits} credits`}</span>
        </Link>
      </nav>
      <Link className="nav-auth" href={account.href}>
        {account.initial ? (
          <span className="nav-auth-initial" aria-hidden="true">
            {account.initial}
          </span>
        ) : null}
        {account.label}
      </Link>
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
