import type { Metadata } from "next";
import Link from "next/link";
import { productFlagsUnavailableMessage, resolveProductFlags } from "@/domain/product-flags";

export const metadata: Metadata = { title: "Activity" };

export const dynamic = "force-dynamic";

export default function ActivityLayout({ children }: { children: React.ReactNode }) {
  const flags = resolveProductFlags();
  if (!flags.dealRadar) {
    return (
      <div className="sub">
        <div className="flow-page site-frame">
          <p className="kicker">Activity</p>
          <h1>Not available</h1>
          <p className="lead">{productFlagsUnavailableMessage("dealRadar")}</p>
          <p>
            <Link className="action" href="/">
              Home
            </Link>
          </p>
        </div>
      </div>
    );
  }
  return children;
}
