"use client";

import Link from "next/link";
import { useState } from "react";
import type { Mode } from "@/domain/types";
import { FilmScrub, type FilmPhase } from "./FilmScrub";
import { HomeSearch } from "./HomeSearch";

export function HomeStage() {
  const [mode, setMode] = useState<Mode>("personal");
  const [phase, setPhase] = useState<FilmPhase>("open");

  return (
    <div className="home-story">
      <section className="film-pin">
        <div className="film-sticky">
          <div className="film-stage">
            <img className="film-poster" src="/frames/poster.jpg" alt="" width={1920} height={1080} />
            <FilmScrub mode={mode} onPhase={setPhase} />
          </div>
          <div className={`film-overlay phase-${phase}`}>
            <div className="film-copy">
              <div>
                <p className="kicker">One car, two goals</p>
                <h1>Describe the car you need</h1>
                <p className="lead">Buy it for yourself, or buy it to resell. The price check and the gaps stay on the page.</p>
              </div>
              <div>
                <HomeSearch onModeChange={setMode} />
                <p className="sample-link">
                  <Link href="/report/sample">See a sample report</Link>
                  <span> (labeled sample, no credit)</span>
                </p>
              </div>
            </div>
            <p className="sale-caption">Not a car for sale</p>
          </div>
        </div>
      </section>
      <div className="marquee" aria-hidden="true">
        <div className="marquee-track">
          <span>For me</span>
          <span>For resale</span>
          <span>Price badge</span>
          <span>Mileage</span>
          <span>Full analysis</span>
          <span>For agents</span>
          <span>For me</span>
          <span>For resale</span>
          <span>Price badge</span>
          <span>Mileage</span>
          <span>Full analysis</span>
          <span>For agents</span>
        </div>
      </div>
      <section className="story-after reveal">
        <p className="kicker">How it works</p>
        <ol className="steps-3 story-steps">
          <li>
            <strong>01 Say which goal</strong>
            <span>For me, or for resale. A note, a budget, and a ZIP. Resale also asks what profit you want and what repairs you can do.</span>
          </li>
          <li>
            <strong>02 Read the listing</strong>
            <span>Photo, price, miles, and a free Good, Fair, or High price badge. Save the search if you want alerts. Alerts are a plan, not a report credit.</span>
          </li>
          <li>
            <strong>03 Open the full analysis</strong>
            <span>1 credit shows the numbers, what we could not check, and a buy, negotiate, or pass line. Your agent can request that same analysis.</span>
          </li>
        </ol>
        <p className="sample-link">
          <Link href="/pricing">See pricing</Link>
          <span>. Report credits and Deal Radar plans are separate.</span>
        </p>
      </section>
      <section className="story-after trust-row story-trust reveal" aria-label="How a verdict is built">
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
    </div>
  );
}
