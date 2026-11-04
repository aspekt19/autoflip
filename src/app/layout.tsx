import type { Metadata } from "next";
import { Header } from "@/components/Header";
import "./globals.css";

export const metadata: Metadata = {
  title: "AutoFlip — a clear verdict on a used car",
  description: "Evaluation preview. Compare a used-car listing with current comps, history flags, recalls, and fuel cost.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;600;700&family=Source+Serif+4:opsz,wght@8..60,560;8..60,650&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <div className="eval-banner">
          <div className="wrap">Evaluation preview. Listing figures are from the configured listings provider or a labeled sample. This is not a production offer.</div>
        </div>
        <Header />
        <main id="main">{children}</main>
        <footer className="site-footer">
          <div className="wrap">
            AutoFlip prepares a price verdict from listing comps and public government data. It is not a dealer, lender, inspector, or insurer. Recalls can be incomplete. Confirm the car, the out-the-door price, and any open campaigns with the seller before you pay.
          </div>
        </footer>
      </body>
    </html>
  );
}
