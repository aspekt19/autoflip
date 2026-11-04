import Link from "next/link";
import { topFlipCandidates } from "@/domain/flip-rank";
import type { Listing } from "@/domain/types";

function car(partial: Partial<Listing> & Pick<Listing, "vin" | "priceUsd">): Listing {
  return {
    year: 2014,
    make: "Honda",
    model: "Civic",
    trim: null,
    miles: 90_000,
    city: "Miami",
    state: "FL",
    zip: "33101",
    dealer: null,
    vdp: null,
    primaryImage: null,
    carfaxUrl: null,
    used: true,
    cpo: false,
    accidentCount: null,
    oneOwner: null,
    ownerCount: null,
    usageType: null,
    fuel: null,
    engine: null,
    drivetrain: null,
    bodyStyle: "Sedan",
    latitude: null,
    longitude: null,
    removedAt: null,
    source: "sample",
    ...partial,
  };
}

const recorded = [
  car({ vin: "COMPARE0000000001", priceUsd: 7_500 }),
  car({ vin: "COMPARE0000000002", priceUsd: 9_000 }),
  car({ vin: "COMPARE0000000003", priceUsd: 10_500 }),
  car({ vin: "COMPARE0000000004", priceUsd: 11_200 }),
  car({ vin: "COMPARE0000000005", priceUsd: 6_200 }),
];

export default function ComparePage() {
  const [best] = topFlipCandidates(recorded, new Date("2026-11-04T00:00:00Z"), 1);
  return (
    <div className="sub">
      <div className="sheet-page">
        <p className="kicker">Demo</p>
        <h1>Same candidate, two explanations</h1>
        <p className="lead">
          This page uses a labeled sample of five asking prices. It is not a live market scan and not a stored model reply.
        </p>
        <div className="choice-grid">
          <article className="choice-card">
            <strong className="choice-title">Code only</strong>
            <span className="choice-desc">
              {best
                ? `${best.listing.year} ${best.listing.make} ${best.listing.model} at $${best.listing.priceUsd?.toLocaleString("en-US")}. Estimate from ${best.compCount} comps in this sample. Profit mid $${best.profitMidUsd?.toLocaleString("en-US")}. Speed: ${best.speed}.`
                : "No candidate."}
            </span>
          </article>
          <article className="choice-card">
            <strong className="choice-title">With SERV</strong>
            <span className="choice-desc">Explanation unavailable. No recorded SERV reply is stored for this sample.</span>
          </article>
        </div>
        <p>
          <Link href="/find">Back to find a car</Link>
        </p>
      </div>
    </div>
  );
}
