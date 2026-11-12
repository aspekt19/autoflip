import type { Metadata } from "next";
import Link from "next/link";
import { ResaleChatFlow } from "@/components/ResaleChatFlow";
import { productFlagsUnavailableMessage, resolveProductFlags } from "@/domain/product-flags";

export const metadata: Metadata = { title: "Resale" };

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
        <h1>Resale</h1>
        <p className="lead">
          Chat with SERV about the flip you want. SERV asks whatever it needs, then searches live inventory in the
          same conversation. If nothing fits, you get that explanation and no verdict. A delivered verdict uses 1 report
          credit. Chat turns without a verdict are free. Not a profit guarantee.
        </p>
        <div className="onboarding-note">
          <strong>How it works</strong>
          <ol>
            <li>A budget is required. ZIP code, distance, body type, makes, miles, repair skill, and how fast you want to sell are optional.</li>
            <li>
              Lemonless ranks cars for sale now with the same price math as the rest of the site, then a review picks
              which shortlisted cars to look at and whether to buy, negotiate, or pass.
            </li>
            <li>
              Each car shows a negotiation estimate, fees and tax, a repair allowance, how it is priced below similar
              listings (after costs), and days to sell when we know them — plus risks and what to check before buying.
              If we do not know something, the card says so.
            </li>
          </ol>
          <p>Not a profit guarantee. No invented listings.</p>
        </div>
        <ResaleChatFlow />
      </div>
    </div>
  );
}
