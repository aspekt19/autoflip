import type { Metadata } from "next";
import { CheckFlow } from "@/components/AssistantFlow";

export const metadata: Metadata = { title: "Check a listing" };

export default function CheckPage() {
  return (
    <div className="sub">
      <div className="flow-page">
        <p className="kicker">Check a listing</p>
        <h1>Look at one specific car</h1>
        <p className="lead">A listing link already has a price. A VIN does not, so we ask for the price, mileage, and ZIP first.</p>
        <CheckFlow />
      </div>
    </div>
  );
}