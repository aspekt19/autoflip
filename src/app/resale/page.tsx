import type { Metadata } from "next";
import Link from "next/link";
import { ResaleFlow } from "@/components/ResaleFlow";
import { productFlagsUnavailableMessage, resolveProductFlags } from "@/domain/product-flags";

export const metadata: Metadata = { title: "Resale estimate" };

/** Runtime flag — must not bake RESALE_EVALUATE_ENABLED at build time. */
export const dynamic = "force-dynamic";

export default function ResalePage() {
  const flags = resolveProductFlags();
  if (!flags.resaleEvaluate) {
    return (
      <div className="sub">
        <div className="flow-page site-frame">
          <p className="kicker">Resale</p>
          <h1>Not available</h1>
          <p className="lead">{productFlagsUnavailableMessage("resaleEvaluate")}</p>
          <p>
            <Link className="action" href="/">
              Home
            </Link>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="sub">
      <div className="flow-page site-frame">
        <p className="kicker">For resale</p>
        <h1>Resale estimate</h1>
        <p className="lead">
          One car at a time: buy-ceiling estimate, expected resale range from similar listings, and example costs. Sign-in
          required. Not a profit guarantee.
        </p>
        <div className="onboarding-note">
          <strong>What this is</strong>
          <ol>
            <li>You enter year, make, model, miles, and the ask you would pay.</li>
            <li>Lemonless compares that ask with similar dealer listings using the same adjusted-comparables price math as the rest of the product.</li>
            <li>You get a buy ceiling, a resale range, example fees/recon, and a margin with High / Medium / Low confidence — or “Not enough similar cars.”</li>
          </ol>
          <p>Saved-search Deal Radar alerts are a separate preview surface and may be off.</p>
        </div>
        <ResaleFlow />
      </div>
    </div>
  );
}
