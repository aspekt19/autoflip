import type { Metadata } from "next";
import { Header } from "@/components/Header";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "AutoFlip", template: "%s — AutoFlip" },
  description: "A clear verdict on a used car, from the listing and public records.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta name="color-scheme" content="light dark" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@500;700&family=Source+Serif+4:opsz,wght@8..60,400;8..60,600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <p className="eval-line">Preview. Listing figures come from dealer listings or a labeled sample. This is not a production offer.</p>
        <Header />
        <main id="main">{children}</main>
        <p className="foot-note">
          AutoFlip prepares a price verdict from listing comps and public government data. It is not a dealer, lender, inspector, or insurer. Recalls can be incomplete. Confirm the car, the out-the-door price, and any open campaigns with the seller before you pay.
        </p>
        <footer className="colophon">
          <a className="brand brand-foot" href="/">
            <img src="/logo.svg" alt="" width={32} height={32} />
            <span className="brand-name">AutoFlip</span>
          </a>
          <p className="foot-links">
            <a href="/radar">Deal Radar</a>
            <a href="/credits">Credits</a>
            <a href="/developers">Developers</a>
          </p>
          <p>Evaluation preview</p>
        </footer>
      </body>
    </html>
  );
}
