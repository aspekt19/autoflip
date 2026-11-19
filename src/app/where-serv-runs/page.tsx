import type { Metadata } from "next";
import Link from "next/link";
import findProofData from "../../../eval/results/find-gemini-proof-2026-11-13.json";
import servComparisonData from "../../../eval/results/proof-serv-compare-2026-11-13.json";
import { PIPELINE_STEPS } from "@/domain/serv-pipeline";
import { loadServRunAggregateStats } from "@/io/decision-audit-store";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Where SERV runs" };

const findRun = findProofData.run;
const comparison = servComparisonData.examples[0];
const featuresOff = comparison.variants.features_off;
const featuresOn = comparison.variants.features_on;

const number = (value: number) => new Intl.NumberFormat("en-US").format(value);
const utcDate = (value: string) =>
  new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));

function publicRunUrl(links: Array<{ label: string; href: string }>) {
  return links.find((item) => item.label === "Public /run")?.href ?? null;
}

export default async function WhereServRunsPage() {
  let stats: Awaited<ReturnType<typeof loadServRunAggregateStats>> | null = null;
  try {
    stats = await loadServRunAggregateStats();
  } catch {
    // The recorded execution artifacts below remain available independently
    // of the optional persisted sealed-report aggregate.
  }
  const offUrl = publicRunUrl(featuresOff.links);
  const onUrl = publicRunUrl(featuresOn.links);

  return (
    <div className="sub">
      <div className="sheet-page site-frame prose">
        <p className="kicker">Transparency · Runtime and evidence</p>
        <h1>Where SERV runs</h1>
        <p className="lead">
          SERV is Lemonless' reasoning and decision layer. It interprets the shopper's brief,
          selects application tools, evaluates returned evidence and chooses an action. TypeScript
          executes provider lookups, computes prices and financial figures, and enforces hard
          constraints. The execution records below show what ran, when it ran, and what it returned.
        </p>

        <section>
          <h2>Pipeline</h2>
          <p className="hint">
            [SERV] marks a reasoning or decision step. [code] marks deterministic application work:
            provider requests, evidence normalization, calculations and validation.
          </p>
          <ol className="steps-3 story-steps">
            {PIPELINE_STEPS.map((step) => (
              <li key={step.id}>
                <strong>
                  [{step.by}] {step.surface} — {step.name}
                </strong>
                <span>{step.detail}</span>
              </li>
            ))}
          </ol>
        </section>

        <section>
          <h2>Recorded Find execution</h2>
          <p className="hint">
            Completed {utcDate(findRun.finishedAt)} UTC · {findRun.execution}. This is a recorded
            execution of the same server-side Find workflow used by the application, with isolated
            in-memory state. It did not charge customer credits or change production data.
          </p>
          <ul className="refuse">
            <li><strong>Result:</strong> {findRun.status}; {findRun.verdict.replaceAll("_", " ")} ({findRun.confidence} confidence).</li>
            <li><strong>SERV model:</strong> {findRun.servModel}.</li>
            <li><strong>Runtime:</strong> {(findRun.durationMs / 1000).toFixed(1)} seconds.</li>
            <li><strong>SERV calls:</strong> {number(findRun.servCalls)}.</li>
            <li><strong>Application-tool activity:</strong> {number(findRun.toolCalls)} calls across {number(findRun.toolRounds)} tool rounds.</li>
            <li><strong>Inventory:</strong> {number(findRun.inventorySearchCount)} searches; {number(findRun.inventoryListingsReturned)} listings returned.</li>
            <li><strong>Token usage:</strong> {number(findRun.totalTokens)} total ({number(findRun.inputTokens)} input, {number(findRun.outputTokens)} output); {number(findRun.cachedTokens)} cached input tokens.</li>
            <li><strong>SERV capabilities recorded:</strong> {findRun.features.join(", ")}.</li>
            <li><strong>Customer credits charged:</strong> {findRun.creditsCharged ? "yes" : "no"}.</li>
            <li><strong>Production data changed:</strong> {findRun.productionDataChanged ? "yes" : "no"}.</li>
            <li><strong>Run ID:</strong> <code>{findRun.id}</code>.</li>
          </ul>
          <p className="hint">
            The recommendation was “needs inspection,” not an unconditional buy: the report selected
            a real listing, attached VIN and vehicle-evidence checks, and retained unresolved
            inspection and out-the-door-price items.
          </p>
          <p className="btn-row">
            <Link className="quiet" href="/proof">Read the complete case study</Link>
            <a
              className="quiet"
              href="https://github.com/aspekt19/autoflip/blob/main/eval/results/find-gemini-proof-2026-11-13.json"
              target="_blank"
              rel="noreferrer"
            >
              Open archived execution record
            </a>
          </p>
        </section>

        <section>
          <h2>Production run comparison: SERV features on and off</h2>
          <p>
            On November 13, the same buyer brief was run twice through the live Find workflow,
            approximately one minute apart. Both runs performed their own inventory search and each
            reported 40 cars found. This is evidence that the two feature routes executed; it is not
            a controlled replay against an identical frozen listing set, so it should not be read as
            proof that the extensions alone caused the different picks.
          </p>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Route</th>
                  <th>SERV calls</th>
                  <th>Tool rounds</th>
                  <th>Verdict-hop configuration</th>
                  <th>Recorded result</th>
                  <th>Run</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">Extensions off</th>
                  <td>{featuresOff.servCalls}</td>
                  <td>{featuresOff.toolRounds}</td>
                  <td>Base SERV reasoning; no Kronos, Multipath or Shadow Agent on the final selection hop.</td>
                  <td>{featuresOff.pick}</td>
                  <td>
                    {offUrl ? <a href={offUrl} target="_blank" rel="noreferrer">Open run</a> : "Archived record"}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Extensions on</th>
                  <td>{featuresOn.servCalls}</td>
                  <td>{featuresOn.toolRounds}</td>
                  <td>Kronos + Multipath + Shadow Agent on the final selection hop, with Prompt Guard retained.</td>
                  <td>{featuresOn.pick}</td>
                  <td>
                    {onUrl ? <a href={onUrl} target="_blank" rel="noreferrer">Open run</a> : "Archived record"}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="hint">
            The feature-enabled run recorded no feature rejections. The two picks and inventory
            snapshots are preserved as separate run records. The comparison demonstrates actual
            feature routing and tool execution, not a statistically conclusive quality uplift.
            It is not a frozen listing snapshot: each arm searched live inventory on its own.
            Both recorded picks had a source-reported accident, so they are not evidence that
            the current no-accident rule accepted them. The run page keeps that car off the
            primary pick. A prose offer in this table is the recorded model text; the structured
            offer on the run is the offer the page renders.
          </p>
          <p>
            <a
              href="https://github.com/aspekt19/autoflip/blob/main/eval/results/proof-serv-compare-2026-11-13.json"
              target="_blank"
              rel="noreferrer"
            >
              Open the paired execution record and evidence
            </a>
          </p>
        </section>

        {stats && stats.trailCount > 0 ? (
          <section>
            <h2>Persisted sealed-report audit totals</h2>
            <p className="hint">
              Separate aggregate calculated from persisted, hash-linked report trails. These totals
              are distinct from the recorded execution artifacts above.
            </p>
            <ul className="refuse">
              <li>Sealed trails: <strong>{number(stats.trailCount)}</strong>.</li>
              <li>SERV review steps: <strong>{number(stats.servCallCount)}</strong>.</li>
              <li>Calculation steps: <strong>{number(stats.codeStepCount)}</strong>.</li>
              <li>Second-check agreements: <strong>{number(stats.secondCheckAgreements)}</strong>.</li>
              <li>Second-check disagreements: <strong>{number(stats.secondCheckDisagreements)}</strong>.</li>
              {stats.newestSealedAt ? (
                <li>Newest sealed trail: <strong>{utcDate(stats.newestSealedAt)} UTC</strong>.</li>
              ) : null}
            </ul>
            <p className="hint">
              <Link href="/api/serv-stats">Open the sealed-report aggregate JSON</Link>.
            </p>
          </section>
        ) : null}

        <p className="btn-row">
          <Link className="quiet" href="/proof">Proof comparisons</Link>
          <Link className="quiet" href="/agents">Agent API</Link>
          <Link className="ghost" href="/">Home</Link>
        </p>
      </div>
    </div>
  );
}
