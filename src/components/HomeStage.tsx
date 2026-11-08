"use client";

import Link from "next/link";
import { useState } from "react";
import type { Mode } from "@/domain/types";
import { BrandHeroTitle } from "./BrandLockup";
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
                <p className="kicker">Used-car verdicts you can check.</p>
                <BrandHeroTitle />
                <p className="lead">Find better cars. Detect hidden risks. Make smarter decisions.</p>
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
            <span>For me, or for resale. A short note starts the search. Budget, ZIP, and seller distance come next in the flow. Resale also asks what profit you want and what repairs you can do.</span>
          </li>
          <li>
            <strong>02 Read the listing</strong>
            <span>Photo, price, miles, and a Good, Fair, or High price badge. Find search costs 1 report credit. Save the search if you want alerts — alerts are a Radar plan, not a report credit.</span>
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
      <section className="story-after trust-row story-trust reveal" aria-label="What Lemonless checks">
        <article>
          <strong>Real numbers</strong>
          <span>Prices, mileage and costs are calculated from real listings, never guessed.</span>
        </article>
        <article>
          <strong>Hidden risks</strong>
          <span>Title, recalls and odometer checks surface what the seller won&apos;t mention.</span>
        </article>
        <article>
          <strong>Proof for every verdict</strong>
          <span>Each report shows how it was checked and why.</span>
        </article>
      </section>
    </div>
  );
}
