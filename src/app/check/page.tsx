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
          Paste any listing link and Lemonless reads the public page, or enter a VIN for a free-source dossier. Sign in
          is required. Verified accounts get 3 free VIN or listing checks per UTC month, then 1 report credit.
        </p>
        <div className="onboarding-note">
          <strong>What you get</strong>
          <ol>
            <li>
              By listing link: fetch the page, extract vehicle facts, compare the ask with similar cars, flag red
              flags, run free government checks when a VIN is found, and estimate out-the-door tax.
            </li>
            <li>
              By VIN: decode, recalls, complaints, crash ratings, fuel economy, known model-year notes, and any current
              listings for that VIN — not a paid history report.
            </li>
          </ol>
          <p>A check is a screening tool, not an inspection or a complete history record.</p>
        </div>
        <CheckFlow />
      </div>
    </div>
  );
}
