import type { Metadata } from "next";
import Link from "next/link";
import {
  LemonlessAnswer,
  Links,
  VerbatimAnswer,
  verdictLabel,
} from "@/app/proof/answer-text";
import { loadProofPageData, type ProofExample, type ProofLink, type SnapshotComparisonProof } from "@/domain/proof-page-runs";

function uniqueLinks(links: ProofLink[]): ProofLink[] {
  const seen = new Set<string>();
  const unique: ProofLink[] = [];
  for (const link of links) {
    const key = `${link.href}\0${link.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(link);
  }
  return unique;
}


export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Proof" };

function ExampleBlock({ example, index, total }: { example: ProofExample; index: number; total: number }) {
  const order = example.variantOrder;
  const kicker = total > 1 ? `Example ${index + 1} of ${total}` : "Example";

  return (
    <section className="proof-example" id={example.slug}>
      <p className="kicker">{kicker}</p>
      <h2>{example.title}</h2>
      <p>
        The same buyer request, compared side by side. Each answer is on this page as readable text.
        Links stay next to the text so you can check the source, the live run, or the raw files.
      </p>

      <details className="decision" open>
        <summary>The request</summary>
        <div className="decision-body">
          <blockquote>
            <p>{example.query}</p>
          </blockquote>
          <p className="hint">
            Seed {example.seed} · recorded {example.generatedAtLabel}. {example.note}
          </p>
        </div>
      </details>

      {order.map((key) => {
        const variant = example.variants[key];
        if (!variant) return null;
        const lemonless =
          key === "features_off"
            ? example.answers.features_off
            : key === "features_on"
              ? example.answers.features_on
              : null;
        const verbatim =
          key === "plain_llm"
            ? example.answers.plain_llm
            : key === "perplexity"
              ? example.answers.perplexity
              : null;
        return (
          <details className="decision" key={key}>
            <summary>{variant.label}</summary>
            <div className="decision-body">
              <p>{variant.description}</p>
              <p>
                <strong>Pick. </strong>
                {variant.pick}
              </p>
            </div>
            {verbatim ? <VerbatimAnswer answer={verbatim} /> : null}
            {lemonless ? <LemonlessAnswer answer={lemonless} /> : null}
            <div className="decision-body">
              <Links links={variant.links} heading="Links" />
            </div>
          </details>
        );
      })}

      <details className="decision" open>
        <summary>Who wins, criterion by criterion</summary>
        <div className="decision-body">
          <p>
            Each point below says what every variant did, who won, and why. Ties are called ties.
            The table is the same comparison in a compact grid.
          </p>
          {example.criteria.map((criterion) => (
            <article key={criterion.id}>
              <h3>{criterion.label}</h3>
              {order.map((key) => {
                const variant = example.variants[key];
                const cell = criterion.cells[key];
                if (!variant || !cell) return null;
                return (
                  <p key={key}>
                    <strong>{variant.short}. </strong>
                    {cell.summary}
                  </p>
                );
              })}
              <p>
                <strong>Winner: {criterion.winnerLabel}. </strong>
                {criterion.why}
              </p>
              <Links
                links={uniqueLinks(order.flatMap((key) => criterion.cells[key]?.links ?? []))}
                heading="Links for this point"
              />
            </article>
          ))}
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Criterion</th>
                  {order.map((key) => (
                    <th key={key}>{example.variants[key]?.short}</th>
                  ))}
                  <th>Winner</th>
                </tr>
              </thead>
              <tbody>
                {example.criteria.map((criterion) => (
                  <tr key={criterion.id}>
                    <th scope="row">{criterion.label}</th>
                    {order.map((key) => {
                      const cell = criterion.cells[key];
                      return (
                        <td key={key}>
                          <p>{cell?.summary}</p>
                          <Links links={cell?.links ?? []} />
                        </td>
                      );
                    })}
                    <td>
                      <p>
                        <strong>{criterion.winnerLabel}.</strong> {criterion.why}
                      </p>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </details>

      <section>
        <h3>{example.servFeaturesAdd.title}</h3>
        <p>{example.servFeaturesAdd.intro}</p>
        {example.servFeaturesAdd.differences.map((row) => (
          <article key={row.point}>
            <h4>{row.point}</h4>
            <p>{row.detail}</p>
            <Links links={row.links} />
          </article>
        ))}
        <h4>Where the two Lemonless runs agree</h4>
        <ul className="refuse">
          {example.servFeaturesAdd.same.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>

      <section>
        <h3>{example.plainLlmFabrication.title}</h3>
        <p>{example.plainLlmFabrication.intro}</p>
        <ul className="refuse">
          {example.plainLlmFabrication.findings.map((finding) => (
            <li key={finding.claim}>
              <strong>{finding.claim}</strong>
              {` — ${verdictLabel(finding.verdict)}. `}
              {finding.detail}
              {finding.href ? (
                <>
                  {" "}
                  <a href={finding.href} target="_blank" rel="noreferrer">
                    Source
                  </a>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      {example.perplexityCapture ? (
        <section>
          <h3>{example.perplexityCapture.title}</h3>
          <p>{example.perplexityCapture.intro}</p>
          <ul className="refuse">
            {example.perplexityCapture.findings.map((finding) => (
              <li key={finding.claim}>
                <strong>{finding.claim}</strong>
                {` — ${verdictLabel(finding.verdict)}. `}
                {finding.detail}
                {finding.href ? (
                  <>
                    {" "}
                    <a href={finding.href} target="_blank" rel="noreferrer">
                      Source
                    </a>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section>
        <h3>Cost (calls and tokens)</h3>
        <p>{example.cost.note}</p>
        <ul className="refuse">
          <li>
            Plain chat: {String(example.cost.plain_llm.servCalls)} call,{" "}
            {String(example.cost.plain_llm.totalTokens)} tokens (
            {String(example.cost.plain_llm.reasoningTokens)} reasoning). Provider dollar cost was not
            returned.
          </li>
          <li>
            Lemonless, features off: {String(example.cost.features_off.servCalls)} calls,{" "}
            {String(example.cost.features_off.totalTokens)} tokens (
            {String(example.cost.features_off.cachedTokens)} cached). Harness estimate $
            {String(example.cost.features_off.harnessEstimatedUsd)}.
          </li>
          <li>
            Lemonless, features on: {String(example.cost.features_on.servCalls)} calls,{" "}
            {String(example.cost.features_on.totalTokens)} tokens (
            {String(example.cost.features_on.cachedTokens)} cached). Harness estimate $
            {String(example.cost.features_on.harnessEstimatedUsd)}.
          </li>
          <li>The captured Perplexity answer has no call-cost figure in this comparison.</li>
        </ul>
      </section>
    </section>
  );
}


function SnapshotComparisonBlock({ comparison }: { comparison: SnapshotComparisonProof }) {
  const off = comparison.arms.features_off;
  const on = comparison.arms.features_on;

  return (
    <section className="proof-example" id="frozen-snapshot-serv-ab">
      <p className="kicker">Frozen snapshot · live SERV A/B</p>
      <h2>{comparison.metadata.title}</h2>
      <p>
        One Auto.dev listing search captured {comparison.snapshot.candidates.length} candidates.
        The same immutable snapshot was then sent to SERV twice: once with verdict features off
        and once with the additional verdict feature bundle on. This isolates the verdict
        step; it is not a full end-to-end test of every vehicle-data provider.
        {comparison.repeatRun ? ` A second full run was also triggered unintentionally by PR synchronization; it is disclosed below.` : ""}
      </p>
      <p className="hint">
        Captured {comparison.metadata.capturedAt} · run #{comparison.metadata.runId} ·{" "}
        <a href={comparison.metadata.runUrl} target="_blank" rel="noreferrer">GitHub Actions run</a>
        {" · "}
        <a
          href={`https://github.com/aspekt19/autoflip/blob/${comparison.metadata.headSha}/eval/results/snapshot-serv-ab-2026-11-13.json`}
          target="_blank"
          rel="noreferrer"
        >
          committed evidence JSON
        </a>
      </p>

      <details className="decision" open>
        <summary>Buyer request and frozen data</summary>
        <div className="decision-body">
          <blockquote><p>{comparison.query}</p></blockquote>
          <p>
            ZIP {comparison.snapshot.buyerZip} · radius {comparison.snapshot.radiusMiles} mi ·
            asking-price search cap ${comparison.snapshot.askingPriceSearchCapUsd.toLocaleString("en-US")} ·
            mileage cap {comparison.snapshot.mileageCap.toLocaleString("en-US")} mi ·
            {comparison.snapshot.candidates.length} candidates.
          </p>
          <h3>What data was actually called</h3>
          <ul className="refuse">
            {comparison.metadata.providersCalled.map((provider) => <li key={provider}>{provider}</li>)}
          </ul>
          <p>
            Not called in this isolated test: {comparison.metadata.providersNotCalled.join(", ")}.
            The ZIP geocode succeeded; dealer distances came from listing coordinates or the bundled
            ZIP-centroid table.
          </p>
          <h3>Data limitations</h3>
          <ul className="refuse">
            {comparison.snapshot.dataCaveats.map((caveat) => <li key={caveat}>{caveat}</li>)}
          </ul>
        </div>
      </details>

      <details className="decision" open>
        <summary>Two SERV decisions on the same snapshot</summary>
        <div className="decision-body">
          <h3>Features off</h3>
          <p>
            <strong>{off.pick.year} {off.pick.make} {off.pick.model}</strong> · VIN{" "}
            <code>{off.pick.vin}</code> · asking ${off.pick.askingPriceUsd.toLocaleString("en-US")} ·{" "}
            {off.pick.miles.toLocaleString("en-US")} mi · {off.pick.distanceMiles} mi away.
          </p>
          <p>
            Opening offer ${off.openingOfferUsd?.toLocaleString("en-US") ?? "not returned"} ·
            walk-away ${off.walkAwayUsd?.toLocaleString("en-US") ?? "not returned"}.
          </p>
          <p>{off.rationale}</p>
          <p className="hint">
            Requested/returned model: {off.requestedModel} / {off.responseModel} · response{" "}
            <code>{off.responseId}</code> · {off.latencyMs.toLocaleString("en-US")} ms ·{" "}
            {off.usage.totalTokens.toLocaleString("en-US")} tokens · harness estimate ${off.estimatedCostUsd.toFixed(2)}.
          </p>

          <h3>Features on</h3>
          <p>
            <strong>{on.pick.year} {on.pick.make} {on.pick.model}</strong> · VIN{" "}
            <code>{on.pick.vin}</code> · asking ${on.pick.askingPriceUsd.toLocaleString("en-US")} ·{" "}
            {on.pick.miles.toLocaleString("en-US")} mi · {on.pick.distanceMiles} mi away.
          </p>
          <p>
            Opening offer ${on.openingOfferUsd?.toLocaleString("en-US") ?? "not returned"} ·
            walk-away ${on.walkAwayUsd?.toLocaleString("en-US") ?? "not returned"}.
          </p>
          <p>{on.rationale}</p>
          <p className="hint">
            Requested/returned model: {on.requestedModel} / {on.responseModel} · response{" "}
            <code>{on.responseId}</code> · {on.latencyMs.toLocaleString("en-US")} ms ·{" "}
            {on.usage.totalTokens.toLocaleString("en-US")} tokens · harness estimate ${on.estimatedCostUsd.toFixed(2)}.
          </p>
          <p>
            Both responses report the same returned model id ({off.responseModel}); the features-on
            request used the SERV model alias {on.requestedModel}. The response metadata alone does
            not establish which internal transformations were billed or applied beyond the request
            configuration, so the page records requested and returned model separately.
          </p>
        </div>
      </details>

      <section>
        <h3>Criterion-by-criterion result</h3>
        <p>{comparison.result.score}. No criterion winner in this single run.</p>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr><th>Criterion</th><th>Features off</th><th>Features on</th><th>Winner</th></tr>
            </thead>
            <tbody>
              {comparison.criteria.map((criterion) => (
                <tr key={criterion.id}>
                  <th scope="row">{criterion.label}</th>
                  <td>{criterion.featuresOff}</td>
                  <td>{criterion.featuresOn}</td>
                  <td>{criterion.winner}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>{comparison.result.conclusion}</p>
        <p>{comparison.result.notableDifference}</p>
        <p>{comparison.result.latency}</p>
        <p>{comparison.result.cost}</p>
      </section>


      {comparison.repeatRun ? (
        <details className="decision">
          <summary>Repeat run · same snapshot reproduced the same choices</summary>
          <div className="decision-body">
            <p>
              Three additional workflow runs were triggered unintentionally by pull-request synchronization
              while the evidence and Proof page were being committed. They were not planned as additional
              paid experiments. The paid workflow has since been changed to manual dispatch only.
            </p>
            <p>
              Run #{comparison.repeatRun.metadata.runId} · captured {comparison.repeatRun.metadata.capturedAt} ·{" "}
              <a href={comparison.repeatRun.metadata.runUrl} target="_blank" rel="noreferrer">repeat GitHub Actions run</a>.
            </p>
            <p>
              The repeat captured the same {comparison.repeatRun.sameCandidateCount} VINs in the same
              order and returned the same selected VIN in each arm. {comparison.repeatRun.criteriaResult}
            </p>
            <ul className="refuse">
              <li>
                Features off: VIN <code>{comparison.repeatRun.arms.features_off.pickVin}</code> ·{" "}
                {comparison.repeatRun.arms.features_off.latencyMs.toLocaleString("en-US")} ms ·{" "}
                {comparison.repeatRun.arms.features_off.usage.totalTokens.toLocaleString("en-US")} tokens.
              </li>
              <li>
                Features on: VIN <code>{comparison.repeatRun.arms.features_on.pickVin}</code> ·{" "}
                {comparison.repeatRun.arms.features_on.latencyMs.toLocaleString("en-US")} ms ·{" "}
                {comparison.repeatRun.arms.features_on.usage.totalTokens.toLocaleString("en-US")} tokens.
              </li>
            </ul>
            <p>
              The two completed runs account for {comparison.result.totalListingSearches} Auto.dev listing
              searches and {comparison.result.totalServCalls} SERV calls. Combined SERV harness estimate: $
              {comparison.result.completedRunsHarnessEstimateUsd?.toFixed(2)}; this is not a provider invoice,
              and Auto.dev charges are not exposed here.
            </p>
            {comparison.additionalRuns?.map((run) => (
              <p key={run.metadata.runId}>
                Additional run #{run.metadata.runId} ·{" "}
                <a href={run.metadata.runUrl} target="_blank" rel="noreferrer">workflow run</a> ·
                features off picked <code>{run.arms.features_off.pickVin}</code> ·
                features on picked <code>{run.arms.features_on.pickVin}</code> ·
                {run.criteriaResult} · harness estimate $
                {(run.arms.features_off.estimatedCostUsd + run.arms.features_on.estimatedCostUsd).toFixed(2)}.
              </p>
            ))}
            <p className="hint">{comparison.repeatRun.metadata.reason}</p>
          </div>
        </details>
      ) : null}

      <details className="decision">
        <summary>All {comparison.snapshot.candidates.length} candidates in the frozen snapshot</summary>
        <div className="decision-body">
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Vehicle / VIN</th><th>Asking</th><th>Miles</th><th>Location</th><th>Distance</th><th>Feed accidents</th>
                </tr>
              </thead>
              <tbody>
                {comparison.snapshot.candidates.map((candidate) => (
                  <tr key={candidate.vin}>
                    <td>
                      {candidate.year} {candidate.make} {candidate.model}<br />
                      <code>{candidate.vin}</code>
                    </td>
                    <td>${candidate.askingPriceUsd.toLocaleString("en-US")}</td>
                    <td>{candidate.miles.toLocaleString("en-US")}</td>
                    <td>{candidate.location}</td>
                    <td>{candidate.distanceMiles} mi</td>
                    <td>{candidate.listingReportedAccidents ?? "unknown"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </details>
    </section>
  );
}

export default function ProofPage() {
  const data = loadProofPageData();
  const examples = data.examples;
  const hasTrace = data.committedTraces.length > 0;

  return (
    <div className="sub">
      <div className="sheet-page site-frame prose">
        <p className="kicker">Proof</p>
        <h1>Same request, compared in full</h1>
        {examples.length > 0 ? (
          <p className="lead">
            These are live comparisons on the same buyer request. Open any section to read the full
            answer as text — the plain chat, each Lemonless recommendation and why it was made, and
            any captured third-party answer. Links stay visible next to the text.
          </p>
        ) : (
          <p className="lead">
            No live comparison is committed yet. This page does not invent scores or listings to look
            finished.
          </p>
        )}

        {data.snapshotComparison ? <SnapshotComparisonBlock comparison={data.snapshotComparison} /> : null}

        {examples.map((example, index) => (
          <ExampleBlock key={example.id} example={example} index={index} total={examples.length} />
        ))}

        {data.cases.length > 0 ? (
          <section>
            <h2>Earlier multi-arm scoreboard</h2>
            {data.cases.map((row) => (
              <article key={row.caseId}>
                <p className="kicker">{row.synthetic ? "Synthetic case" : "Real case"}</p>
                <h3>{row.title}</h3>
                <ul className="refuse">
                  {row.arms.map((arm) => (
                    <li key={`${row.caseId}-${arm.arm}`}>
                      <strong>{arm.arm}</strong>
                      {arm.qualityNote ? ` — ${arm.qualityNote}` : ""}
                      {typeof arm.costUsd === "number"
                        ? ` Cost recorded: $${arm.costUsd.toFixed(4)}.`
                        : " Cost was not recorded."}
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </section>
        ) : null}

        <section>
          <h2>Committed single-run traces</h2>
          {!hasTrace ? (
            <p>No older committed proof traces with run id, model, and timestamp are in this checkout.</p>
          ) : (
            <ul className="refuse">
              {data.committedTraces.map((trace) => (
                <li key={trace.id}>
                  <p>
                    A recorded review from {trace.generatedAt}. This is not a customer report.
                    {trace.decision ? ` Decision recorded: ${trace.decision}.` : ""}
                  </p>
                  <p className="hint">{trace.disclosure}</p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <p className="btn-row">
          <Link className="quiet" href="/where-serv-runs">
            Where SERV runs
          </Link>
          <Link className="quiet" href="/agents">
            Agent API
          </Link>
        </p>
      </div>
    </div>
  );
}
