import type { Metadata } from "next";
import { Big_Shoulders_Display, Manrope, Orbitron } from "next/font/google";
import { Header } from "@/components/Header";
import { PageFade } from "@/components/PageFade";
import { SmoothScroll } from "@/components/SmoothScroll";
import "./globals.css";

const sans = Manrope({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-sans" });
const display = Orbitron({ subsets: ["latin"], weight: ["500", "600", "700"], variable: "--font-display" });
/** Display cut matches CSS fallback; the plain Big_Shoulders family flakes in some CI font fetches. */
const wide = Big_Shoulders_Display({
  subsets: ["latin"],
  weight: ["700", "800"],
  variable: "--font-wide",
  adjustFontFallback: false,
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "AutoFlip", template: "%s — AutoFlip" },
  description: "A clear verdict on a used car, from the listing and public records.",
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
          AutoFlip prepares a price verdict from listing comps and public government data. It is not a dealer, lender, inspector, or insurer. Recalls can be incomplete. Confirm the car, the out-the-door price, and any open campaigns with the seller before you pay.
        </p>
        <footer className="colophon">
          <a className="brand brand-foot" href="/">
            <img src="/logo.svg" alt="" width={32} height={32} />
            <span className="brand-name">AutoFlip</span>
          </a>
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
