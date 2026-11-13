import type { Metadata } from "next";
import proofData from "../../../eval/results/find-gemini-proof-2026-11-13.json";
import { Links, LemonlessAnswer, VerbatimAnswer } from "./answer-text";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Proof" };

type PlainAnswer = { headline: string; verbatim: string; sourceUrl?: string };
type LemonlessAnswerData = {
  pick: string;
  recommendation: string;
  whyThisCar: string;
  whyThisOffer: string;
  checked: string[];
  unknown: string[];
  rejected: string;
};
type ProofPayload = {
  title: string;
  recordedAt: string;
  prompt: string;
  scopeNote: string;
  gemini: PlainAnswer;
  lemonless: LemonlessAnswerData;
  run: {
    id: string;
    status: string;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    execution: string;
    verdict: string;
    confidence: string;
    servModel: string;
    servCalls: number;
    toolRounds: number;
    toolCalls: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cachedTokens: number;
    features: string[];
    searchTrail: Array<{ zip: string; radiusMiles: number; priceMaxUsd: number; bodyFamily: string; returned: number }>;
    creditsCharged: boolean;
    productionDataChanged: boolean;
    githubRunUrl: string;
  };
  links: { geminiChat: string; listing: string; vinDecode: string; safety: string; fuel: string; githubRun: string };
  disclosures: string[];
};

const proof = proofData as ProofPayload;
const number = (value: number) => new Intl.NumberFormat("en-US").format(value);
const usd = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);

export default function ProofPage() {
  const duration = (proof.run.durationMs / 1000).toFixed(1);
  return (
    <div className="sub">
      <div className="sheet-page site-frame prose">
        <p className="kicker">Proof · Live case study · November 13, 2026</p>
        <h1>One buyer request. Two different approaches.</h1>
        <p className="lead">
          Gemini gave useful model-level guidance. Lemonless Find went a step further: it searched dealer
          inventory, selected an actual listing, checked vehicle-specific data and translated the result
          into a VIN-linked recommendation and a concrete negotiation plan.
        </p>

        <section className="proof-example" id="denver-find-vs-gemini-auto">
          <details className="decision" open>
            <summary>The exact buyer request</summary>
            <div className="decision-body">
              <blockquote><p>{proof.prompt}</p></blockquote>
              <p className="hint">{proof.scopeNote}</p>
            </div>
          </details>

          <h2>Gemini Chat · Auto</h2>
          <p>
            Captured from the shared Gemini conversation. Auto mode selected the underlying model;
            this comparison does not assign a specific model version.
          </p>
          <details className="decision">
            <summary>Read the full Gemini answer</summary>
            <VerbatimAnswer answer={proof.gemini} />
          </details>
          <div className="decision-body">
            <Links links={[{ label: "Open the original shared Gemini conversation", href: proof.links.geminiChat }]} />
          </div>

          <h2>Lemonless Find · SERV</h2>
          <p><strong>Selected listing:</strong> {proof.lemonless.pick}</p>
          <p><strong>Find verdict:</strong> {proof.lemonless.recommendation}</p>
          <details className="decision">
            <summary>Read Find's reasoning and evidence checks</summary>
            <LemonlessAnswer answer={proof.lemonless} />
          </details>
          <div className="decision-body">
            <Links links={[
              { label: "Open the vehicle listing", href: proof.links.listing },
              { label: "Official VIN decode", href: proof.links.vinDecode },
              { label: "Official vehicle safety data", href: proof.links.safety },
              { label: "Fuel economy data source", href: proof.links.fuel }
            ]} />
          </div>

          <h2>Side-by-side comparison</h2>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr><th>Dimension</th><th>Gemini Chat · Auto</th><th>Lemonless Find · SERV</th></tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">Starting point</th>
                  <td>Strong broad advice: suggested two suitable model families and explained winter-driving and family-use trade-offs.</td>
                  <td>Converted the brief into a local inventory search, then evaluated an actual vehicle available to buy.</td>
                </tr>
                <tr>
                  <th scope="row">Vehicle specificity</th>
                  <td>Recommended 2022–2023 Forester trims and a 2023 CX-5; no stock number, VIN or individual seller listing.</td>
                  <td>Identified a 2021 Subaru Forester Premium AWD, VIN JF2SKAJC5MH423912, listed at {usd(20197)} in Longmont, about 28 miles away.</td>
                </tr>
                <tr>
                  <th scope="row">Fit to the actual search</th>
                  <td>Suggested a target profile (including under 65,000 miles) for the buyer to search for.</td>
                  <td>Found a concrete vehicle with 89,215 miles that meets the stated under-100,000-mile ceiling; surfaced the exact mileage and location.</td>
                </tr>
                <tr>
                  <th scope="row">Vehicle-level evidence</th>
                  <td>Presented model/year-level safety and economy claims.</td>
                  <td>Ran a VIN decode identifying the vehicle configuration, retrieved its NHTSA safety ratings, and checked the closest fuel-economy configuration.</td>
                </tr>
                <tr>
                  <th scope="row">Safety detail</th>
                  <td>Discussed family safety and rear-seat improvements at the model-year level.</td>
                  <td>Returned the selected vehicle's lookup result: 5-star overall, front and side ratings, and 4-star rollover. This is vehicle-specific lookup evidence, not a substitute for inspection.</td>
                </tr>
                <tr>
                  <th scope="row">Running-cost detail</th>
                  <td>Gave MPG figures for recommended model families.</td>
                  <td>Returned an estimated 29 MPG combined and a standardized annual fuel-cost estimate of {usd(1670)} for the closest configuration.</td>
                </tr>
                <tr>
                  <th scope="row">Local market grounding</th>
                  <td>Gave approximate Denver-area price ranges for model families.</td>
                  <td>Compared local 2019–2021 Forester asking prices: {usd(19493)}–{usd(20197)}, with a {usd(19797)} median. These are advertised prices, not completed-sale prices.</td>
                </tr>
                <tr>
                  <th scope="row">Negotiation output</th>
                  <td>{usd(24200)} opening offer and {usd(24800)}–{usd(25000)} all-in ceiling, based on a general OTD strategy.</td>
                  <td>{usd(19000)} opening offer and {usd(20000)} vehicle-price walk-away point, anchored to the selected listing and local asking-price evidence; keep the total within {usd(25000)}.</td>
                </tr>
                <tr>
                  <th scope="row">Decision safety</th>
                  <td>Provided a useful checklist and negotiation cautions.</td>
                  <td>Did not claim the car was ready to buy: returned a medium-confidence “needs inspection” verdict and called out the need for an itemized OTD quote and physical checks.</td>
                </tr>
                <tr>
                  <th scope="row">Traceability</th>
                  <td>Shared conversational advice and a Gemini chat link.</td>
                  <td>Links the recommendation to the actual listing, VIN decoder, NHTSA safety lookup, fuel-economy source and technical run record.</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="hint">
            The offers are not identical formats: Gemini proposed an all-in opening number, while Find
            proposed a vehicle-price offer and a vehicle-price walk-away point, with the final OTD amount
            still to be confirmed by the dealer. Find's advantage here is the listing-specific price
            rationale, not a claim that its number is already a final tax-inclusive quote.
          </p>

          <h2>Where Find adds practical value</h2>
          <ul className="refuse">
            <li><strong>From “what model should I look for?” to “here is a car you can contact the seller about.”</strong> Find tied its recommendation to a live listing, VIN, mileage, asking price and distance.</li>
            <li><strong>Evidence attached to the candidate.</strong> The answer connected the selected VIN to configuration data, safety lookup, fuel-economy estimates and local comparable listings.</li>
            <li><strong>A negotiation anchor, not just a budget reminder.</strong> The opening offer and walk-away point were tied to the selected car's asking price and the local comparison set.</li>
            <li><strong>Decision support with a safety brake.</strong> SERV gave a “needs inspection” verdict rather than turning incomplete evidence into an unconditional buy recommendation.</li>
            <li><strong>Auditable workflow.</strong> The page exposes the source links and technical run record, so a reviewer can inspect how the result was produced.</li>
          </ul>
          <p className="hint">
            Gemini also delivered useful high-level advice on winter capability, family use and OTD
            negotiation. The distinction demonstrated here is that Find connected those buying criteria
            to a specific local vehicle and supporting evidence in one workflow.
          </p>

          <h2>What Find did during this run</h2>
          <ul className="refuse">
            <li>Three live inventory searches in ZIP 80202 within 75 miles; two returned 20 listings and one returned none.</li>
            <li>SERV made {proof.run.servCalls} calls and {proof.run.toolCalls} tool calls across {proof.run.toolRounds} tool rounds.</li>
            <li>VIN decode, safety, fuel-economy and local asking-price evidence were requested for the selected vehicle.</li>
            <li>The run completed in {duration} seconds with a {proof.run.confidence}-confidence, needs-inspection verdict.</li>
          </ul>

          <details className="decision">
            <summary>Technical run details</summary>
            <div className="decision-body">
              <p>Execution path: {proof.run.execution}.</p>
              <ul className="refuse">
                <li>SERV model reported by the run: {proof.run.servModel}.</li>
                <li>Token usage: {number(proof.run.totalTokens)} total ({number(proof.run.inputTokens)} input, {number(proof.run.outputTokens)} output), including {number(proof.run.cachedTokens)} cached input tokens.</li>
                <li>Features active: {proof.run.features.join(", ")}.</li>
                <li>Credits charged: {proof.run.creditsCharged ? "yes" : "no"}.</li>
                <li>Production data changed: {proof.run.productionDataChanged ? "yes" : "no"}.</li>
                <li>Find run ID: {proof.run.id}.</li>
              </ul>
              <Links links={[{ label: "Open the GitHub Actions test record", href: proof.run.githubRunUrl }]} />
            </div>
          </details>

          <h2>Scope and limitations</h2>
          <ul className="refuse">
            {proof.disclosures.map((line) => <li key={line}>{line}</li>)}
          </ul>
        </section>
      </div>
    </div>
  );
}
