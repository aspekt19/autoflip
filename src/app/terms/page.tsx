import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Terms" };

export default function TermsPage() {
  return (
    <div className="sub">
      <div className="sheet-page prose">
        <p>
          <Link href="/">Back to the start</Link>
        </p>
        <h1>Terms</h1>
        <p className="lead">
          Lemonless is an evaluation preview. Use it as a decision aid, not as a purchase, financing, or insurance commitment.
        </p>

        <h2>Service description</h2>
        <p>
          Lemonless turns a US used-car listing into an explainable buy / caution / walk-away reading. Similar listings of the
          same model come from Auto.dev. Recall and complaint context come from NHTSA when available. Code computes the numbers; model writing only
          explains those numbers. Stripe on this site is test mode only and does not collect live payment.
        </p>

        <h2>No warranties</h2>
        <p>
          Public records can be incomplete. Asking prices are not sale prices. A recall campaign on a model year is not proof
          that a specific car was repaired. Sample reports are labeled samples. You remain responsible for confirming the car,
          the out-the-door price, and any open campaigns with the seller before you pay.
        </p>
        <p>
          Lemonless helps you avoid lemons. It is not a guarantee, an inspection, or a vehicle history report — always get a
          pre-purchase inspection. The product name and tagline are aspirational; they do not promise that any car is free of
          defects or that a purchase will be risk-free.
        </p>

        <h2>Credits and plans</h2>
        <p>
          A full report costs one report credit. Deal Radar monitoring is a separate optional plan. Agent API keys spend the
          same report credit as the site. Balances and subscriptions on this preview are for evaluation and may reset when
          storage or demo settings change.
        </p>

        <h2>Acceptable use</h2>
        <p>
          Do not abuse the listings quota, attempt to bypass credit checks, or use the preview to misrepresent Lemonless as a
          licensed dealer, lender, or official vehicle-history bureau.
        </p>

        <h2>Privacy</h2>
        <p>
          See the <Link href="/privacy">Privacy</Link> page for what this preview stores. Lemonless does not sell personal data.
        </p>
      </div>
    </div>
  );
}
