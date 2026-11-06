import type { Metadata } from "next";
import { Bebas_Neue, Manrope, Orbitron } from "next/font/google";
import { Header } from "@/components/Header";
import { PageFade } from "@/components/PageFade";
import { SmoothScroll } from "@/components/SmoothScroll";
import "./globals.css";

const sans = Manrope({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-sans" });
const display = Orbitron({ subsets: ["latin"], weight: ["500", "600", "700"], variable: "--font-display" });
/** Condensed display for headings. Replaces Big_Shoulders, which flakes in CI Google Fonts fetches. */
const wide = Bebas_Neue({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-wide",
  display: "swap",
});

const TAGLINE = "Buy smart. Stay lemonless.";
const CATEGORY = "Used-car verdicts you can check.";

export const metadata: Metadata = {
  title: { default: `Lemonless — ${TAGLINE}`, template: "%s — Lemonless" },
  description: `${TAGLINE} ${CATEGORY}`,
  openGraph: {
    title: `Lemonless — ${TAGLINE}`,
    description: `${TAGLINE} ${CATEGORY}`,
    siteName: "Lemonless",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: `Lemonless — ${TAGLINE}`,
    description: `${TAGLINE} ${CATEGORY}`,
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
        <Header />
        <main id="main">
          <PageFade>{children}</PageFade>
        </main>
        <p className="foot-note">
          <strong>Buy smart. Stay lemonless.</strong> Lemonless prepares a price verdict from listing comps and public
          government data. It is not a dealer, lender, inspector, or insurer. Recalls can be incomplete. Confirm the car,
          the out-the-door price, and any open campaigns with the seller before you pay.
        </p>
        <footer className="colophon">
          <a className="brand brand-foot" href="/">
            <img src="/logo.svg" alt="" width={32} height={32} />
            <span className="brand-name">Lemonless</span>
          </a>
          <p className="foot-tagline">Buy smart. Stay lemonless.</p>
          <p className="foot-links">
            <a href="/find">Find</a>
            <a href="/check">Check by VIN</a>
            <a href="/radar">Price alerts</a>
            <a href="/reports">Reports</a>
            <a href="/favorites">Saved cars</a>
            <a href="/compare-cars">Compare cars</a>
            <a href="/pricing">Pricing</a>
            <a href="/developers">For AI agents</a>
            <a href="/privacy">Privacy</a>
            <a href="/terms">Terms</a>
          </p>
        </footer>
      </body>
    </html>
  );
}
