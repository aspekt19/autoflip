import Link from "next/link";

export default function HomePage() {
  return (
    <>
      <section className="hero hero-home">
        <div className="hero-wash" aria-hidden="true">
          <span className="orb orb-y" />
          <span className="orb orb-b" />
          <svg className="flow" viewBox="0 0 800 520" preserveAspectRatio="none">
            <path d="M-40 460 C 160 420, 220 300, 400 320 S 640 460, 860 280" />
            <path d="M-20 500 C 200 440, 280 360, 480 380 S 680 500, 880 340" />
          </svg>
        </div>
        <div className="wrap hero-copy">
          <p className="kicker">Used cars</p>
          <h1>Find the right used car, then know if it&apos;s a good deal</h1>
          <p className="lead">
            Describe what you need, or check one listing. A full analysis of a single car is 1 credit.
          </p>
          <div className="choice-grid">
            <Link className="choice-card" href="/find">
              <span className="choice-icon" aria-hidden="true">
                <svg viewBox="0 0 32 32" width="32" height="32">
                  <path d="M16 6a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7z" fill="none" stroke="currentColor" strokeWidth="2" />
                  <circle cx="16" cy="13" r="2.2" fill="currentColor" />
                </svg>
              </span>
              <span className="choice-title">Help me choose a car</span>
              <span className="choice-desc">Tell us what you need. We&apos;ll suggest a few directions to search.</span>
              <span className="choice-arrow" aria-hidden="true">
                →
              </span>
            </Link>
            <Link className="choice-card" href="/check">
              <span className="choice-icon" aria-hidden="true">
                <svg viewBox="0 0 32 32" width="32" height="32">
                  <rect x="7" y="5" width="18" height="22" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
                  <path d="M11 12h10M11 17h10M11 22h6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </span>
              <span className="choice-title">Check a specific listing</span>
              <span className="choice-desc">Paste a listing link, or a VIN with the price and mileage.</span>
              <span className="choice-arrow" aria-hidden="true">
                →
              </span>
            </Link>
          </div>
          <p className="sample-link">
            <Link href="/report/sample">See a sample report</Link>
            <span> (labeled sample, no credit)</span>
          </p>
        </div>
      </section>
      <section className="band paper">
        <div className="wrap">
          <h2 className="center-title">How it works</h2>
          <ol className="steps-3">
            <li>
              <strong>Tell us the need</strong>
              <span>A short note, a budget, and at most two follow-up questions.</span>
            </li>
            <li>
              <strong>See directions, then listings</strong>
              <span>Watch a search if you want alerts. Monitoring is included in your plan and doesn&apos;t use report credits.</span>
            </li>
            <li>
              <strong>Analyze one car</strong>
              <span>1 credit answers whether that car fits you or the deal. It does not inspect the car.</span>
            </li>
          </ol>
          <p className="sample-link">
            <Link href="/pricing">Radar plans</Link>
            <span> are preview prices. Report credits stay separate.</span>
          </p>
        </div>
      </section>
      <section className="wrap trust-row" aria-label="How a verdict is built">
        <article>
          <strong>Data shown</strong>
          <span>We show which data the verdict is based on.</span>
        </article>
        <article>
          <strong>Facts vs estimates</strong>
          <span>We separate facts from estimates.</span>
        </article>
        <article>
          <strong>What to check</strong>
          <span>We flag what still needs checking before you buy.</span>
        </article>
      </section>
    </>
  );
}
