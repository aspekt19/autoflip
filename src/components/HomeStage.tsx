"use client";

import Link from "next/link";
import { useState } from "react";
import type { Mode } from "@/domain/types";
import { HOME_ACCOUNT_LINE } from "./account-cta-copy";
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
            <div className="film-copy site-frame">
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
                <p className="account-note">{HOME_ACCOUNT_LINE}</p>
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
      <section className="story-after site-frame reveal">
        <p className="kicker">How it works</p>
        <ol className="steps-3 story-steps">
          <li>
            <strong>01 Say which goal</strong>
            <span>
              For me: a short note starts Find. Budget, ZIP, and seller distance come next. For resale: open the one-car
              Resale estimate — buy ceiling, similar-listing range, and example costs.
            </span>
          </li>
          <li>
            <strong>02 Read the listing</strong>
            <span>
              Photo, price, miles, and a Good, Fair, or High price badge from similar asking prices. Find is a
              credit-priced search when billing is enabled.
            </span>
          </li>
          <li>
            <strong>03 Open the full analysis</strong>
            <span>1 credit shows the numbers, what we could not check, and a buy, negotiate, or pass line. Your agent can request that same analysis.</span>
          </li>
        </ol>
        <p className="sample-link">
          <Link href="/pricing">See pricing</Link>
          <span>
            . Report credits are separate from optional Radar plans.{" "}
            <Link href="/resale">Resale estimate</Link> is a one-car tool, not a profit guarantee.
          </span>
        </p>
      </section>
      <section className="story-after site-frame trust-row story-trust reveal" aria-label="What Lemonless checks">
        <article>
          <strong>Real numbers</strong>
          <span>Prices, mileage and costs are calculated from real listings, never guessed.</span>
        </article>
        <article>
          <strong>Hidden risks</strong>
          <span>Recall campaigns and complaint counts come from NHTSA when available. Title brands and odometer brands are not checked here.</span>
        </article>
        <article>
          <strong>Proof for every verdict</strong>
          <span>Each report shows how it was checked and why.</span>
        </article>
      </section>
    </div>
  );
}
