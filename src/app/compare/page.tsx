import type { Metadata } from "next";
import { readFileSync } from "node:fs";
import path from "node:path";
import Link from "next/link";
import { comparisonBoard, type SavedEval } from "@/domain/eval-view";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Compare" };

function savedEval(): SavedEval | null {
  try {
    const raw = readFileSync(path.join(process.cwd(), "eval", "results", "latest.json"), "utf8");
    const parsed = JSON.parse(raw) as SavedEval;
    if (!parsed || !Array.isArray(parsed.rows)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export default function ComparePage() {
  const board = comparisonBoard(savedEval());
  return (
    <>
      <section className="hero hero-home compare-hero">
        <div className="hero-wash" aria-hidden="true">
          <span className="orb orb-y" />
          <span className="orb orb-b" />
          <svg className="flow" viewBox="0 0 800 520" preserveAspectRatio="none">
            <path d="M-40 460 C 160 420, 220 300, 400 320 S 640 460, 860 280" />
            <path d="M-20 500 C 200 440, 280 360, 480 380 S 680 500, 880 340" />
          </svg>
        </div>
        <div className="sheet-page site-frame hero-copy">
          <p className="kicker">Comparison</p>
          <h1>Standard AI vs Lemonless</h1>
          <p className="lead">The same listing, read two ways. Lemonless keeps the writing tied to the figures it calculated.</p>
        </div>
      </section>
      <div className="compare-sheet site-frame">
        {board.examples.length === 0 ? (
          <section className="compare-listing">
            <p className="kicker">No saved run</p>
            <h2>Waiting for a real comparison</h2>
            <p>No listing is shown until a saved run exists. Nothing here is filled in to look finished.</p>
            <div className="choice-grid compare-pair">
              <article className="compare-card">
                <strong className="choice-title">Standard AI</strong>
                <p>No answer yet.</p>
              </article>
              <article className="compare-card">
                <strong className="choice-title">Lemonless</strong>
                <p>No answer yet.</p>
              </article>
            </div>
          </section>
        ) : (
          board.examples.map((example, index) => (
            <section className="compare-listing" key={`${index}-${example.title}-${example.task}`}>
              <p className="kicker">{example.synthetic ? "Synthetic trap" : "Saved listing"}</p>
              <h2>{example.title}</h2>
              <p>{example.task}</p>
              <div className="choice-grid compare-pair">
                <article className="compare-card">
                  <strong className="choice-title">Standard AI</strong>
                  <p>{example.standard}</p>
                  <ul className="compare-marks">
                    {example.standardMarks.map((mark) => (
                      <li className={mark.startsWith("Fooled") || mark.startsWith("Invented") || mark.startsWith("Missing") || mark.startsWith("Did not") || mark.startsWith("Answer") ? "is-bad" : ""} key={mark}>
                        {mark}
                      </li>
                    ))}
                  </ul>
                </article>
                <article className="compare-card">
                  <strong className="choice-title">Lemonless</strong>
                  <p>{example.checked}</p>
                  <ul className="compare-marks">
                    {example.checkedMarks.map((mark) => (
                      <li className={mark.startsWith("Followed") || mark.startsWith("Invented") || mark.startsWith("Missing") || mark.startsWith("Did not") || mark.startsWith("Answer") ? "is-bad" : ""} key={mark}>
                        {mark}
                      </li>
                    ))}
                  </ul>
                </article>
              </div>
            </section>
          ))
        )}
        {board.trapFound ? null : board.hasRun ? <p className="compare-gap">In the saved run, standard AI was not caught following a hidden instruction.</p> : null}
        {board.didNotHelp ? <p className="compare-gap">{board.didNotHelp}</p> : null}
        <div className="compare-table-wrap">
          <table className="compare-table">
            <caption className="kicker">Saved results</caption>
            <thead>
              <tr>
                <th scope="col">Check</th>
                <th scope="col">Standard AI</th>
                <th scope="col">Lemonless</th>
              </tr>
            </thead>
            <tbody>
              {board.summary.length === 0 ? (
                <tr>
                  <td colSpan={3}>No saved rows yet.</td>
                </tr>
              ) : (
                board.summary.map((row) => (
                  <tr key={row.label}>
                    <th scope="row">{row.label}</th>
                    <td>{row.standard}</td>
                    <td>{row.checked}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <div className="btn-row compare-actions">
          <Link className="action" href="/report/sample">
            See a sample report
          </Link>
          <Link className="quiet" href="/find">
            Find a car
          </Link>
        </div>
      </div>
    </>
  );
}
