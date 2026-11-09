import type { Metadata } from "next";
import Link from "next/link";
import { productFlagsUnavailableMessage, resolveProductFlags } from "@/domain/product-flags";

export const metadata: Metadata = { title: "Deal Radar" };

export const dynamic = "force-dynamic";

export default function RadarLayout({ children }: { children: React.ReactNode }) {
  const flags = resolveProductFlags();
  if (!flags.dealRadar) {
    return (
      <div className="sub">
        <div className="flow-page site-frame">
          <p className="kicker">Deal Radar</p>
          <h1>Not available</h1>
          <p className="lead">{productFlagsUnavailableMessage("dealRadar")}</p>
          <p className="btn-row">
            <Link className="action" href="/resale">
              Resale estimate
            </Link>
            <Link className="quiet" href="/">
              Home
            </Link>
          </p>
        </div>
      </div>
    );
  }
  return children;
}
