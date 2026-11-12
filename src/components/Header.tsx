"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { headerAuthConfiguredProp, headerBalancePresentation } from "@/domain/account-load";
import { CREDIT_BALANCE_EVENT } from "@/domain/credit-balance-event";
import type { ProductFlags } from "@/domain/product-flags";
import { BrandLockup } from "./BrandLockup";
import { headerAuthControl } from "./header-auth";
import { primaryNavLinks, splitPrimaryNavLinks } from "./header-nav";
import { useAccountLoad } from "./use-account-load";

/**
 * Primary nav. Product surface visibility follows runtime GET /api/product-flags.
 */
export function Header() {
  const pathname = usePathname();
  const accountLoad = useAccountLoad(pathname);
  /** Purchase events can move the count before the next /api/account response. */
  const [liveCredits, setLiveCredits] = useState<number | null>(null);
  /** null = not yet known; prefer runtime flags over a build-time bake. */
  const [flags, setFlags] = useState<ProductFlags | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const menuBtnRef = useRef<HTMLButtonElement>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const navId = useId();
  const moreId = useId();

  const navLinks = primaryNavLinks({ flags });
  const { core: coreLinks, more: moreLinks } = splitPrimaryNavLinks(navLinks);

  useEffect(() => {
    function onBalance(event: Event) {
      const detail = (event as CustomEvent<number>).detail;
      if (typeof detail === "number" && Number.isFinite(detail)) setLiveCredits(detail);
    }
    window.addEventListener(CREDIT_BALANCE_EVENT, onBalance);
    return () => window.removeEventListener(CREDIT_BALANCE_EVENT, onBalance);
  }, []);

  useEffect(() => {
    function refreshBalance() {
      if (document.visibilityState === "hidden") return;
      void accountLoad.reload();
    }
    window.addEventListener("focus", refreshBalance);
    document.addEventListener("visibilitychange", refreshBalance);
    return () => {
      window.removeEventListener("focus", refreshBalance);
      document.removeEventListener("visibilitychange", refreshBalance);
    };
  }, [accountLoad.reload]);

  // Sync from the ledger when /api/account returns. Do not clear liveCredits to
  // null on every body identity change — that flickers 9→10 during a search when
  // an event published a temporary count and the next account load restores it.
  useEffect(() => {
    if (accountLoad.phase !== "loaded") return;
    if (typeof accountLoad.body?.credits !== "number") return;
    setLiveCredits(accountLoad.body.credits);
  }, [accountLoad.phase, accountLoad.body]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/product-flags")
      .then((response) => response.json())
      .then((body: { flags?: ProductFlags }) => {
        if (!cancelled && body.flags) setFlags(body.flags);
      })
      .catch(() => {
        // Leave null so defaults (resale on, radar off) apply via local fallbacks.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setMenuOpen(false);
    setMoreOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!menuOpen && !moreOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" || event.key === "Esc") {
        event.preventDefault();
        if (moreOpen) {
          setMoreOpen(false);
          queueMicrotask(() => moreBtnRef.current?.focus());
          return;
        }
        setMenuOpen(false);
        queueMicrotask(() => menuBtnRef.current?.focus());
      }
    }
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node | null;
      if (!target) return;
      if (navRef.current?.contains(target) || menuBtnRef.current?.contains(target)) return;
      setMenuOpen(false);
      setMoreOpen(false);
    }
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [menuOpen, moreOpen]);

  const accountCredits =
    accountLoad.phase === "loaded" && typeof accountLoad.body?.credits === "number" ? accountLoad.body.credits : null;
  const balance = headerBalancePresentation({
    phase: accountLoad.phase,
    credits: accountLoad.phase === "loaded" ? (liveCredits ?? accountCredits) : null,
  });
  const signedIn = accountLoad.phase === "loaded" && accountLoad.body?.authenticated === true;
  const accountEmail =
    accountLoad.phase === "loaded" && typeof accountLoad.body?.email === "string" ? accountLoad.body.email : null;
  const account = headerAuthControl({
    authenticated: signedIn,
    email: accountEmail,
    pathname,
    authConfigured: headerAuthConfiguredProp(accountLoad.phase, accountLoad.body),
  });

  function closeMenus() {
    setMenuOpen(false);
    setMoreOpen(false);
  }

  const overMedia = pathname === "/";

  return (
    <header
      className={`bar${overMedia ? " bar-over-media" : ""}`}
      data-testid="site-header"
    >
      <BrandLockup size={58} animated className="brand" surface="dark" />
      <nav id={navId} ref={navRef} aria-label="Primary" className={menuOpen ? "nav-open" : undefined}>
        {coreLinks.map((item) => (
          <Link key={item.href} className="nav-core" href={item.href} onClick={closeMenus}>
            {item.label}
          </Link>
        ))}
        {moreLinks.map((item) => (
          <Link key={item.href} className="nav-overflow" href={item.href} onClick={closeMenus}>
            {item.label}
          </Link>
        ))}
        {moreLinks.length > 0 ? (
          <div className={`nav-more${moreOpen ? " nav-more-open" : ""}`}>
            <button
              ref={moreBtnRef}
              className="nav-more-btn"
              type="button"
              aria-expanded={moreOpen}
              aria-controls={moreId}
              aria-haspopup="menu"
              onClick={() => setMoreOpen((open) => !open)}
            >
              More
            </button>
            <div id={moreId} className="nav-more-panel" role="menu" hidden={!moreOpen}>
              {moreLinks.map((item) => (
                <Link key={item.href} role="menuitem" href={item.href} onClick={closeMenus}>
                  {item.label}
                </Link>
              ))}
            </div>
          </div>
        ) : null}
        {balance.kind === "failed" ? (
          <button
            className="nav-go"
            type="button"
            aria-label={balance.accessibleLabel}
            title={balance.accessibleLabel}
            onClick={() => accountLoad.retry()}
          >
            <span className="nav-go-full">{balance.full}</span>
            <span className="nav-go-short">{balance.short}</span>
          </button>
        ) : balance.kind === "loading" ? (
          <span className="nav-go" role="status" aria-live="polite" aria-busy="true" aria-label={balance.accessibleLabel} title={balance.accessibleLabel}>
            <span className="nav-go-full">{balance.full}</span>
            <span className="nav-go-short">{balance.short}</span>
          </span>
        ) : (
          <Link className="nav-go" href="/credits" aria-label={balance.accessibleLabel} onClick={closeMenus}>
            <span className="nav-go-full">{balance.full}</span>
            <span className="nav-go-short">{balance.short}</span>
          </Link>
        )}
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
        onClick={() => {
          setMoreOpen(false);
          setMenuOpen((open) => !open);
        }}
      >
        {menuOpen ? "Close" : "Menu"}
      </button>
    </header>
  );
}
