import type { Metadata } from "next";
import localFont from "next/font/local";
import { BrandLockup, BrandTagline } from "@/components/BrandLockup";
import { FooterProductLink } from "@/components/FooterProductLink";
import { Header } from "@/components/Header";
import { PageFade } from "@/components/PageFade";
import { SmoothScroll } from "@/components/SmoothScroll";
import "./globals.css";

/** Self-hosted Manrope — next/font/google Manrope fetch flakes in CI (null CSS parse). */
const sans = localFont({
  src: [
    { path: "../fonts/manrope/manrope-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "../fonts/manrope/manrope-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "../fonts/manrope/manrope-latin-600-normal.woff2", weight: "600", style: "normal" },
    { path: "../fonts/manrope/manrope-latin-700-normal.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-sans",
  display: "swap",
});
/** Self-hosted Orbitron — next/font/google Orbitron fetch also flakes in CI. */
const display = localFont({
  src: [
    { path: "../fonts/orbitron/orbitron-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "../fonts/orbitron/orbitron-latin-600-normal.woff2", weight: "600", style: "normal" },
    { path: "../fonts/orbitron/orbitron-latin-700-normal.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-display",
  display: "swap",
});
/** Condensed display for headings. Self-hosted after Google Fonts CI flakes. */
const wide = localFont({
  src: [{ path: "../fonts/bebas-neue/bebas-neue-latin-400-normal.woff2", weight: "400", style: "normal" }],
  variable: "--font-wide",
  display: "swap",
});

const TAGLINE = "Buy smart. Stay lemonless.";
const CATEGORY = "Used-car verdicts you can check.";
const SITE_URL = process.env.NEXT_PUBLIC_APP_URL || "https://autoflip-umber.vercel.app";

export const metadata: Metadata = {
  title: { default: `Lemonless — ${TAGLINE}`, template: "%s — Lemonless" },
  description: `${TAGLINE} ${CATEGORY}`,
  metadataBase: new URL(SITE_URL),
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  openGraph: {
    title: `Lemonless — ${TAGLINE}`,
    description: `${TAGLINE} ${CATEGORY}`,
    siteName: "Lemonless",
    type: "website",
    images: [{ url: "/og-logo.png", width: 1200, height: 630, alt: "Lemonless" }],
  },
  twitter: {
    card: "summary_large_image",
    title: `Lemonless — ${TAGLINE}`,
    description: `${TAGLINE} ${CATEGORY}`,
    images: ["/og-logo.png"],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${display.variable} ${wide.variable}`}>
      <body>
        <SmoothScroll />
        <a className="skip" href="#main">
          Skip to content
        </a>
        {/* Scout nav: Header fetches /api/scout capabilities at runtime — do not bake SCOUT_UI_ENABLED here. */}
        <Header />
        <main id="main">
          <PageFade>{children}</PageFade>
        </main>
        <p className="foot-note">
          <strong className="brand-inline-tagline">
            <span className="tagline-prefix">Buy smart. Stay </span>
            <span className="tagline-lemon">lemon</span>
            <span className="tagline-less">less.</span>
          </strong>{" "}
          Lemonless prepares a price verdict from similar listings of the same model and public government data. It is not a dealer,
          lender, inspector, or insurer. Recalls can be incomplete. Confirm the car, the out-the-door price, and any open
          campaigns with the seller before you pay.
        </p>
        <footer className="colophon">
          <BrandLockup size={40} animated={false} className="brand brand-foot" surface="dark" />
          <BrandTagline />
          <p className="hint lemonless-disclaimer">
            Lemonless helps you avoid lemons. It is not a guarantee, an inspection, or a vehicle history report — always get a
            pre-purchase inspection.
          </p>
          <p className="foot-links">
            <a href="/find">Find</a>
            <a href="/check">Check a car</a>
            <FooterProductLink />
            <a href="/reports">Reports</a>
            <a href="/favorites">Saved cars</a>
            <a href="/compare-cars">Compare cars</a>
            <a href="/pricing">Pricing</a>
            <a href="/account">Account</a>
            <a href="/developers">For AI agents</a>
            <a href="/privacy">Privacy</a>
            <a href="/terms">Terms</a>
          </p>
        </footer>
      </body>
    </html>
  );
}
