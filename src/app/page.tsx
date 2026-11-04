import { SearchPanel } from "@/components/SearchPanel";

export default function HomePage() {
  return (
    <>
      <section className="hero">
        <div className="hero-wash" aria-hidden="true">
          <span className="orb orb-y" />
          <span className="orb orb-b" />
          <svg className="flow" viewBox="0 0 800 520" preserveAspectRatio="none">
            <path d="M-40 420 C 140 390, 200 210, 340 230 S 560 420, 860 160" />
            <path d="M-40 300 C 180 270, 250 90, 420 140 S 620 300, 860 70" />
          </svg>
        </div>
        <div className="hero-grid">
          <div>
            <p className="kicker">Used cars</p>
            <h1>Should you buy this car, or walk away?</h1>
            <p className="lead">
              Paste a listing or scan a make and model. AutoFlip scores the asking price against comparable listings, mileage, history flags, recalls, and fuel cost.
            </p>
            <ul className="facts">
              <li>A saved search is checked on a schedule</li>
              <li>A full report is 1 credit</li>
              <li>The paragraph does not invent the numbers</li>
            </ul>
          </div>
          <figure className="dossier">
            <div className="file-stack">
              <div className="stack-back back-a" aria-hidden="true" />
              <div className="stack-back back-b" aria-hidden="true" />
              <article className="sheet">
                <p className="file-chip">Report · Sample shape</p>
                <p className="sheet-label">Verdict</p>
                <p className="sheet-title">Good deal, fair, overpriced, or walk away</p>
                <ol className="trace">
                  <li>Asking price against current comps</li>
                  <li>Mileage, history flags, recalls, fuel</li>
                  <li>A paragraph that only explains those figures</li>
                </ol>
              </article>
            </div>
            <figcaption>Sample of the report shape. Not a live listing.</figcaption>
          </figure>
        </div>
      </section>
      <section className="band paper" id="lookup">
        <div className="wrap split">
          <div>
            <h2>Look up a car</h2>
            <ol className="path">
              <li>
                <strong>Scan</strong>
                <span>Deal Radar stays inside one search and does not spend a credit.</span>
              </li>
              <li>
                <strong>Read the report</strong>
                <span>One credit adds recalls, complaints, and fuel to the price math.</span>
              </li>
              <li>
                <strong>Ask the dealer</strong>
                <span>The report lists questions. It does not inspect the car.</span>
              </li>
            </ol>
          </div>
          <SearchPanel />
        </div>
      </section>
    </>
  );
}
