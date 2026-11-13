import type { Metadata } from "next";
import Link from "next/link";
import {
  LemonlessAnswer,
  Links,
  VerbatimAnswer,
  verdictLabel,
} from "@/app/proof/answer-text";
import { loadProofPageData, type ProofExample, type ProofLink } from "@/domain/proof-page-runs";

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
