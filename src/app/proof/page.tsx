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
          Gemini Chat answered with general model and negotiation advice. Lemonless Find searched live
          inventory and returned a specific vehicle, VIN, evidence checks and a structured offer.
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
                  <th scope="row">Type of answer</th>
                  <td>General recommendations: 2022–2023 Subaru Forester and 2023 Mazda CX-5.</td>
                  <td>One live inventory result selected with a VIN, listing, mileage and seller location.</td>
                </tr>
                <tr>
                  <th scope="row">Specific vehicle</th>
                  <td>No individual listing or VIN in the captured answer.</td>
                  <td>2021 Subaru Forester Premium AWD, VIN JF2SKAJC5MH423912, listed at {usd(20197)}.</td>
                </tr>
                <tr>
                  <th scope="row">Negotiation</th>
                  <td>{usd(24200)} opening offer and {usd(24800)}–{usd(25000)} all-in ceiling.</td>
                  <td>{usd(19000)} opening offer; {usd(20000)} vehicle-price walk-away point; keep total within {usd(25000)}.</td>
                </tr>
                <tr>
                  <th scope="row">Evidence approach</th>
                  <td>Model-level vehicle, safety, fuel-economy and local-market guidance.</td>
                  <td>Listing search, VIN decode, safety lookup, fuel-economy estimate and local asking-price comparisons.</td>
                </tr>
                <tr>
                  <th scope="row">Recommendation granularity</th>
                  <td>Two model-year and trim families to search for.</td>
                  <td>One specific vehicle with a VIN and a direct listing link.</td>
                </tr>
              </tbody>
            </table>
          </div>

          <h2>What Find did during this run</h2>
          <ul className="refuse">
            <li>Three live inventory searches in ZIP 80202 within 75 miles; two returned 20 listings and one returned none.</li>
            <li>SERV made {proof.run.servCalls} calls and {proof.run.toolCalls} tool calls across {proof.run.toolRounds} tool rounds.</li>
            <li>VIN decode, safety, recall/complaint, fuel-economy and local asking-price evidence were requested for the selected vehicle.</li>
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
