# Evaluation artifacts

This directory contains measured SERV traces, profile evaluations, comparison fixtures, and recorded Proof of AI outputs. Each artifact preserves its own generation date and run metadata.

## Recorded artifacts

| File | Purpose |
|---|---|
| find-gemini-proof-2026-11-13.json | Captured Find case used by the public Proof page and the Gemini comparison. Source for [docs/serv-decision-trail-2026-11-13.md](../../docs/serv-decision-trail-2026-11-13.md). |
| proof-serv-compare-2026-11-13.json | Structured proof/comparison record associated with the public Find case. |
| compare-2026-11-13/ | Source/evidence artifacts associated with the November 13 comparison exercise. |
| latest.json / latest.md | Recorded 44-pair profile evaluation snapshot generated 6 November 2026. The report includes profile-level outcomes, latency, token usage, and case-level results. |
| verdict-latest.json / verdict-latest.md | Recorded verdict-evaluation harness output and its run metadata. |

## Archived / historical (kept for provenance; not current product evidence)

These files remain in the repository. Treat them as internal history or noisy harness output, not as the live Proof case or the current default model path.

| File | Why it is archived |
|---|---|
| serv-proof-trace.json / serv-proof-trace.md | **Archived (6 Nov 2026).** Redacted SERV inference trace for the fixed flip-clear fixture / `flip_judge` profile. Requested model `gpt-5.4-mini-serv-multipath`, reported `gpt-5.4-mini-2026-03-17`. Current application default is `gpt-6.1-sol` in `src/server/serv/profiles.ts`. |
| serv-vs-baseline-latest.json | **Archived dry run.** Offline/deterministic decision and baseline harness output. It does not dispatch a live SERV request. |
| comparison-latest.json / comparison-latest.md | **Archived fixture-mode output.** Find/Check comparison harness run on fixtures (common inputs across Lemonless, plain-model, and price-sort arms), not the Nov 13 live Proof inventory case. |
| docs/serv-boundary-audit.md and `docs/serv-boundary-audit-*.md` | **Archived internal history.** Boundary-audit write-ups kept under `docs/` for provenance; not the public Proof narrative. |

## Run the evaluations

From the repository root:

~~~bash
npm run eval:serv
npm run eval:trace
npm run eval:verdict
npm run eval:comparison
~~~

Live SERV evaluation commands require SERV_API_KEY. The trace harness uses a fixed evaluation fixture and writes redacted execution metadata. The comparison harness has an explicit live-run gate; inspect its configuration before enabling provider calls.

The comparison and snapshot harnesses keep common inputs fixed across their evaluation arms. Live inference results and fixture-mode results are stored separately and should be interpreted according to the run metadata in the artifact.

## Evidence conventions

- A real SERV execution is identified by its profile, response ID, reported model, HTTP result, latency, and available usage fields.
- A fixture/dry-run artifact is labelled as such and does not count as a live model response.
- A case-level result is associated with the exact fixture and evaluation code that generated it.
- Raw shopper prompts, VINs, provider facts and free-form model output are not included in the redacted SERV proof trace.
