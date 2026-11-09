import type { Metadata } from "next";
import { CheckFlow } from "@/components/AssistantFlow";

export const metadata: Metadata = { title: "Check a listing" };

export default function CheckPage() {
  return (
    <div className="sub">
      <div className="flow-page">
        <p className="kicker">Check a listing</p>
        <h1>Look at one specific car</h1>
        <p className="lead">Choose a dealer listing link or a 17-character VIN. A link must contain the car&apos;s VIN: Lemonless looks up that VIN in its listings data rather than reading the listing page. A VIN also needs the asking price, mileage and U.S. ZIP code.</p>
        <div className="onboarding-note"><strong>Two levels of checking</strong><ol><li>Free quick check: compares the asking price with similar listings. It does not use a monthly check.</li><li>Full report: 3 free VIN or your own listing URL checks per verified account each UTC month, then 1 report credit. It adds broader market, safety and available history context.</li></ol><p>A report is a screening tool, not an inspection or a complete history record.</p></div>
        <CheckFlow />
      </div>
    </div>
  );
}