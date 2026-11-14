# Evaluation artifacts

This directory contains measured SERV traces, profile evaluations, comparison fixtures, and recorded Proof of AI outputs. Each artifact preserves its own generation date and run metadata.

## Recorded artifacts

| File | Purpose |
|---|---|
| latest.json / latest.md | Recorded 44-pair profile evaluation snapshot generated 6 November 2026. The report includes profile-level outcomes, latency, token usage, and case-level results. |
| serv-proof-trace.json / serv-proof-trace.md | Historical redacted real SERV inference trace generated 6 November 2026 for the fixed flip-clear fixture and flip_judge profile. That run records requested model gpt-5.4-mini-serv-multipath and reported model gpt-5.4-mini-2026-03-17. It is preserved as a dated execution record; the current application default is gpt-6.1-sol in src/server/serv/profiles.ts. |
| find-gemini-proof-2026-11-13.json | Captured Find case used by the public Proof page and the Gemini comparison. |
| proof-serv-compare-2026-11-13.json | Structured proof/comparison record associated with the public Find case. |
| comparison-latest.json / comparison-latest.md | Fixture-mode output from the Find/Check comparison harness. The harness defines common input payloads for the Lemonless, plain-model and price-sort arms. |
| compare-2026-11-13/ | Source/evidence artifacts associated with the November 13 comparison exercise. |
| serv-vs-baseline-latest.json | Offline/dry-run evaluation artifact for the deterministic decision and baseline harness. It does not dispatch a live SERV request. |
| verdict-latest.json / verdict-latest.md | Recorded verdict-evaluation harness output and its run metadata. |

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
