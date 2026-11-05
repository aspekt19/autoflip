import type { Metadata } from "next";
import Link from "next/link";
import { HomeSearch } from "@/components/HomeSearch";

export const metadata: Metadata = { title: "A clear verdict on a used car" };

export default function HomePage() {
  return (
    <>
      <section className="hero hero-home">
        <div className="wrap hero-split">
          <div className="hero-copy">
            <p className="kicker">One car, two goals</p>
            <h1>Describe the car you need</h1>
            <p className="lead">
              Buy it for yourself, or buy it to resell. We rate the price against other listings, show the math, and leave the gaps in view. The same full analysis is 1 credit here, or from your own agent.
            </p>
            <HomeSearch />
            <p className="sample-link">
              <Link href="/report/sample">See a sample report</Link>
              <span> (labeled sample, no credit)</span>
            </p>
          </div>
          <figure className="hero-photo">
            <img src="/hero-suv.jpg" alt="A white sport utility vehicle parked outdoors" width={1400} height={788} />
            <figcaption>Photo: Charlie Deets, Pexels. Not a car for sale.</figcaption>
          </figure>
        </div>
      </section>
      <section className="band paper">
        <div className="wrap">
          <h2 className="center-title">How it works</h2>
          <ol className="steps-3">
            <li>
              <strong>Say which goal</strong>
              <span>For me, or for resale. A note, a budget, and a ZIP. Resale also asks what profit you want and what repairs you can do.</span>
            </li>
            <li>
              <strong>Read the listing</strong>
              <span>Photo, price, miles, and a free Good, Fair, or High price badge. Save the search if you want alerts. Alerts are a plan, not a report credit.</span>
            </li>
            <li>
              <strong>Open the full analysis</strong>
              <span>1 credit shows the numbers, what we could not check, and a buy, negotiate, or pass line. Your agent can request that same analysis.</span>
            </li>
          </ol>
          <p className="sample-link">
            <Link href="/pricing">See pricing</Link>
            <span>. Report credits and Deal Radar plans are separate.</span>
          </p>
        </div>
      </section>
      <section className="wrap trust-row" aria-label="How a verdict is built">
        <article>
          <strong>The math is on the page</strong>
          <span>Price, comps, and the gap are calculated in code and shown.</span>
        </article>
        <article>
          <strong>Gaps stay visible</strong>
          <span>Missing history, mileage, or comps is labeled, not filled in.</span>
        </article>
        <article>
          <strong>Same analysis for agents</strong>
          <span>A key on For agents spends the same report credit.</span>
        </article>
      </section>
    </>
  );
}
