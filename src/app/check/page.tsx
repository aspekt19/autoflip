import type { Metadata } from "next";
import { CheckFlow } from "@/components/CheckFlow";

export const metadata: Metadata = { title: "Check a car" };

export default function CheckPage() {
  return (
    <div className="sub">
      <div className="flow-page site-frame">
        <p className="kicker">Check a car</p>
        <h1>Check a car</h1>
        <p className="lead">
          Enter a VIN for a free-source dossier, or paste listing text. Sign in is required. Verified accounts get 3
          free checks per UTC month, then 1 report credit.
        </p>
        <div className="onboarding-note">
          <strong>What you get</strong>
          <ol>
            <li>
              By VIN: decode, recalls, complaints, crash ratings, fuel economy, known model-year notes, and any current
              listings for that VIN — not a paid history report.
            </li>
            <li>Paste listing text when you already have the price, mileage, and VIN from the page.</li>
          </ol>
          <p>A check is a screening tool, not an inspection or a complete history record.</p>
        </div>
        <CheckFlow />
      </div>
    </div>
  );
}
