import { readFileSync } from "node:fs";
import path from "node:path";
import Link from "next/link";
import { comparisonExamples, type SavedEval } from "@/domain/eval-view";

export const dynamic = "force-dynamic";

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
  const view = comparisonExamples(savedEval());
  return (
    <div className="sub">
      <div className="sheet-page">
        <p className="kicker">Comparison</p>
        <h1>Standard AI vs AutoFlip&apos;s checked AI</h1>
        <p className="lead">
          Side by side answers from the last saved comparison. Synthetic trap text is labeled. Nothing on this page is made up to fill a gap.
        </p>
        {view.examples.length === 0 ? (
          <p>This comparison has not been run yet.</p>
        ) : (
          <>
            {view.trapFound ? null : (
              <p>In the saved run, the standard answer was not caught following a hidden instruction.</p>
            )}
            {view.examples.map((example) => (
              <section key={`${example.title}-${example.task}`}>
                <h2>{example.title}</h2>
                <p className="hint">
                  {example.task}
                  {example.synthetic ? " · Synthetic trap text" : ""}
                </p>
                <div className="choice-grid">
                  <article className="choice-card">
                    <strong className="choice-title">Standard AI</strong>
                    <span className="choice-desc">{example.standardNote}</span>
                    <p>{example.standard}</p>
                  </article>
                  <article className="choice-card">
                    <strong className="choice-title">Checked AI</strong>
                    <span className="choice-desc">{example.checkedNote}</span>
                    <p>{example.checked}</p>
                  </article>
                </div>
              </section>
            ))}
          </>
        )}
        <p>
          <Link href="/find">Back to find a car</Link>
        </p>
      </div>
    </div>
  );
}
