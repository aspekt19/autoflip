import { SearchPanel } from "@/components/SearchPanel";

export default function HomePage() {
  return (
    <>
      <section className="hero">
        <div className="hero-wash" aria-hidden="true">
          <svg className="skyline" viewBox="0 0 760 150" preserveAspectRatio="xMaxYMax meet">
            <path
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              d="M8 150V72H36V44H62V72H98V22H124V72H160V88H198V150M220 150V60H248V28H270V60H308V12H334V60H372V80H410V150M432 150V66H458V34H484V66H526V16H552V66H590V92H628V150"
            />
          </svg>
          <svg className="ping" viewBox="0 0 80 80">
            <circle cx="40" cy="40" r="5" fill="#1f5bff" />
            <circle className="ring" cx="40" cy="40" r="16" />
            <circle className="ring ring-2" cx="40" cy="40" r="28" />
          </svg>
          <svg className="tag" viewBox="0 0 72 48">
            <path d="M6 8h36l22 16-22 16H6V8z" fill="#ffd60a" stroke="currentColor" strokeWidth="2" />
            <circle cx="18" cy="24" r="3" fill="currentColor" />
          </svg>
          <div className="lane">
            <span className="lane-dashes" />
          </div>
          <svg className="drive-car" viewBox="0 0 228 78">
            <path d="M14 54h48l22-20h58l18 20h52" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinejoin="round" />
            <path d="M84 34l12-16h42l14 16" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinejoin="round" />
            <path d="M100 20h34l10 12H96V20z" fill="#ffd60a" stroke="currentColor" strokeWidth="2" />
            <path d="M186 42h16" stroke="#ffd60a" strokeWidth="4" strokeLinecap="round" />
            <g className="wheel">
              <circle cx="62" cy="56" r="13" fill="var(--canvas)" stroke="currentColor" strokeWidth="2.6" />
              <circle cx="62" cy="56" r="4" fill="#1f5bff" />
            </g>
            <g className="wheel wheel-rear">
              <circle cx="176" cy="56" r="13" fill="var(--canvas)" stroke="currentColor" strokeWidth="2.6" />
              <circle cx="176" cy="56" r="4" fill="#1f5bff" />
            </g>
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
