import { AssistantFlow } from "@/components/AssistantFlow";

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
              Start with what you need. AutoFlip suggests a few search directions, watches a search you save, and spends 1 credit only when you ask for a full analysis of one car.
            </p>
            <ul className="facts">
              <li>Monitoring is included in your plan and doesn&apos;t use report credits</li>
              <li>A full analysis of one car is 1 credit</li>
              <li>We show which data the verdict is based on. We separate facts from estimates. We flag what still needs checking before you buy.</li>
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
                  <li>Facts, estimates, and what still needs checking</li>
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
            <h2>How a search works</h2>
            <ol className="path">
              <li>
                <strong>Tell us the need</strong>
                <span>A short note, a budget, and at most two follow-up questions.</span>
              </li>
              <li>
                <strong>See directions, then listings</strong>
                <span>Watch a search if you want alerts. That does not spend a report credit.</span>
              </li>
              <li>
                <strong>Analyze one car</strong>
                <span>1 credit answers whether that car fits you or the deal. It does not inspect the car.</span>
              </li>
            </ol>
          </div>
          <AssistantFlow />
        </div>
      </section>
    </>
  );
}
