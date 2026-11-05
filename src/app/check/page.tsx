import type { Metadata } from "next";
import { CheckFlow } from "@/components/AssistantFlow";

export const metadata: Metadata = { title: "Check a listing" };

export default function CheckPage() {
  return (
    <div className="sub">
      <div className="flow-page">
        <p className="kicker">Check a listing</p>
        <h1>Look at one specific car</h1>
        <p className="lead">Choose a dealer listing link or a 17-character VIN. A link must contain the car&apos;s VIN: AutoFlip looks up that VIN in its listings data rather than reading the listing page. A VIN also needs the asking price, mileage and U.S. ZIP code.</p>
        <CheckFlow />
      </div>
    </div>
  );
}