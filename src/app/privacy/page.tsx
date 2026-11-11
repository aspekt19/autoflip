import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Privacy" };

export default function PrivacyPage() {
  return (
    <div className="sub">
      <div className="sheet-page site-frame prose">
        <p>
          <Link href="/">Back to the start</Link>
        </p>
        <h1>Privacy</h1>
        <p className="lead">
          Lemonless is an evaluation preview. This page describes what the preview stores and what it does not do.
        </p>

        <h2>What Lemonless is</h2>
        <p>
          Lemonless prepares a price verdict from used-car listing data and public government records. It is not a dealer,
          lender, inspector, insurer, or production vehicle-history service. Stripe runs in test mode only on this preview.
        </p>

        <h2>Data sources</h2>
        <ul>
          <li>
            <strong>Auto.dev</strong> — dealer listing search used for evaluation. Coverage and freshness follow that free-plan feed.
          </li>
          <li>
            <strong>Government recall database</strong> — public recall, complaint, and factory-detail lookups when those
            services respond. The official site is nhtsa.gov.
          </li>
          <li>
            Figures on a report (fair value, price gap, flip estimates) are calculated in Lemonless&apos;s own code from those inputs.
          </li>
        </ul>

        <h2>What we store</h2>
        <ul>
          <li>
            A browser cookie identifies this device so credits, saved searches, favorites, and report history can continue
            across page loads. When sign-in is turned on, a verified Google or email account keeps that balance after
            cookies are cleared. This preview does not promise account recovery on every deploy.
          </li>
          <li>
            Saved searches, alerts, report history, favorites, keys you create for software that calls Lemonless, and
            credit balances are stored in this preview’s database.
          </li>
          <li>
            When Telegram linking is enabled for a preview, connecting a chat stores a link you create. Stripe test
            checkout stores the customer and subscription identifiers needed to manage a test-mode plan.
          </li>
        </ul>

        <h2>What we do not do</h2>
        <ul>
          <li>We do not sell personal data.</li>
          <li>We do not invent listing prices, mileage, or history to fill gaps.</li>
          <li>We do not claim that a clean public-record check is a complete vehicle history.</li>
        </ul>

        <h2>Contact</h2>
        <p>
          Questions about this preview can go through the repository maintainer for{" "}
          <a href="https://github.com/aspekt19/autoflip">aspekt19/autoflip</a>.
        </p>
      </div>
    </div>
  );
}
