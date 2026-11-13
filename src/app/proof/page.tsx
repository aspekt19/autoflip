import type { Metadata } from "next";
import Link from "next/link";
import { loadProofPageData, type ProofLink } from "@/domain/proof-page-runs";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Proof" };

function Links({ links }: { links: ProofLink[] }) {
  if (!links.length) return null;
  return (
    <ul className="refuse">
      {links.map((link) => (
        <li key={link.href}>
          <a href={link.href} target="_blank" rel="noreferrer">
            {link.label}
          </a>
        </li>
      ))}
    </ul>
  );
}

export default function ProofPage() {
  const data = loadProofPageData();
  const compare = data.servCompare;
  const hasTrace = data.committedTraces.length > 0;

  return (
    <div className="sub">
      <div className="sheet-page site-frame prose">
        <p className="kicker">Proof</p>
        <h1>Same request, three ways</h1>
        {compare ? (
          <>
            <p className="lead">
              One buyer request, run three ways on 13 Nov 2026. The question is where Lemonless wins,
              against whom, and what the SERV review step on the final verdict hop actually adds.
              Every cell below has a link you can open.
            </p>
            <blockquote>
              <p>{compare.query}</p>
            </blockquote>
            <p className="hint">
              Seed {compare.seed} · same SERV production model on all three arms · recorded {compare.generatedAtLabel}.{" "}
              {compare.note}
            </p>

            <section>
              <h2>The three variants</h2>
              {(["plain_llm", "features_off", "features_on"] as const).map((key) => {
                const variant = compare.variants[key];
                if (!variant) return null;
                return (
                  <article key={key}>
                    <h3>{variant.label}</h3>
                    <p>{variant.description}</p>
                    <p>
                      <strong>Pick: </strong>
                      {variant.pick}
                    </p>
                    <Links links={variant.links} />
                  </article>
                );
              })}
            </section>

            <section>
              <h2>Where we win, criterion by criterion</h2>
              <p>
                Columns are the three variants. The winner column says who won that point and why.
                Ties are called ties.
              </p>
              <div style={{ overflowX: "auto" }}>
                <table>
                  <thead>
                    <tr>
                      <th>Criterion</th>
                      <th>{compare.variants.plain_llm.short}</th>
                      <th>{compare.variants.features_off.short}</th>
                      <th>{compare.variants.features_on.short}</th>
                      <th>Winner</th>
                    </tr>
                  </thead>
                  <tbody>
                    {compare.criteria.map((criterion) => (
                      <tr key={criterion.id}>
                        <th scope="row">{criterion.label}</th>
                        {(["plain_llm", "features_off", "features_on"] as const).map((key) => {
                          const cell = criterion.cells[key];
                          return (
                            <td key={key}>
                              <p>{cell.summary}</p>
                              <Links links={cell.links} />
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
            </section>

            <section>
              <h2>{compare.servFeaturesAdd.title}</h2>
              <p>{compare.servFeaturesAdd.intro}</p>
              {compare.servFeaturesAdd.differences.map((row) => (
                <article key={row.point}>
                  <h3>{row.point}</h3>
                  <p>{row.detail}</p>
                  <Links links={row.links} />
                </article>
              ))}
              <h3>Where the two Lemonless runs agree</h3>
              <ul className="refuse">
                {compare.servFeaturesAdd.same.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </section>

            <section>
              <h2>{compare.plainLlmFabrication.title}</h2>
              <p>{compare.plainLlmFabrication.intro}</p>
              <ul className="refuse">
                {compare.plainLlmFabrication.findings.map((finding) => (
                  <li key={finding.claim}>
                    <strong>{finding.claim}</strong>
                    {` — ${finding.verdict.replaceAll("_", " ")}. `}
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

            <section>
              <h2>Cost (SERV calls and tokens)</h2>
              <p>{compare.cost.note}</p>
              <ul className="refuse">
                <li>
                  Plain LLM: {String(compare.cost.plain_llm.servCalls)} call,{" "}
                  {String(compare.cost.plain_llm.totalTokens)} tokens (
                  {String(compare.cost.plain_llm.reasoningTokens)} reasoning). Provider dollar cost
                  was not returned.
                </li>
                <li>
                  Lemonless, features off: {String(compare.cost.features_off.servCalls)} SERV calls,{" "}
                  {String(compare.cost.features_off.totalTokens)} tokens (
                  {String(compare.cost.features_off.cachedTokens)} cached). Harness estimate $
                  {String(compare.cost.features_off.harnessEstimatedUsd)}.
                </li>
                <li>
                  Lemonless, features on: {String(compare.cost.features_on.servCalls)} SERV calls,{" "}
                  {String(compare.cost.features_on.totalTokens)} tokens (
                  {String(compare.cost.features_on.cachedTokens)} cached). Harness estimate $
                  {String(compare.cost.features_on.harnessEstimatedUsd)}.
                </li>
              </ul>
            </section>
          </>
        ) : (
          <p className="lead">
            No live three-way comparison is committed yet. This page does not invent scores or
            listings to look finished.
          </p>
        )}

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
