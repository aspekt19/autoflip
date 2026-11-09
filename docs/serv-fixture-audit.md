# SERV fixture audit (post-PR107 honesty)

**Date:** 2026-11-09  
**Rule:** Never invent SERV outputs for users or jury. Test-only mocks stay in `*.test.ts`.

## PR107 / sample surface

| Item | Shown to users/jury? | Real or written? | Action |
|------|----------------------|------------------|--------|
| `fixtures/serv/verdict-revision.json` (buy→negotiate + challenge) | Was (via `/report/sample`) | **Written by agent** — no run id, model, timestamp, or raw HTTP | **Removed.** Not replaced with fiction. |
| `/report/sample` agent trail (revision + independent disagreement) | Yes | Was fabricated from that JSON | **Now:** “Example not yet recorded” until a live recording exists |
| `docs/screenshots/serv-trail/sample-report-*.jpeg` | Docs / PR screenshots | Captured UI of the **invented** trail | **Relabeled withdrawn** in `docs/screenshots/serv-trail/README.md`; do not cite as real SERV |
| `docs/screenshots/serv-trail/check-*.jpeg` | Docs | Check UI chrome (sign-in / trail chrome) — not a SERV transcript | Kept with note: not a SERV proof trace |
| `src/domain/agent-second-pass.test.ts` | No (unit only) | Written fixtures for parser/domain rules | **Keep** (test-only) |
| `src/domain/agent-trail.test.ts` | No | Written fixtures (incl. “two newer comps…” strings) | **Keep** (test-only; never rendered on site) |
| `src/domain/build-check-agent-verdict.test.ts` | No | Written fixtures | **Keep** (test-only) |
| `src/server/serv/bypass.test.ts` profile schemas | No | Contract tests | **Keep** |
| `src/server/serv-revision-recording.test.ts` | No | Parser honesty tests (accept/reject shapes) | **Keep** (test-only; not imported by sample) |
| `docs/agent-verdict-schema.json` | Docs schema | Schema only (not a run) | **Keep** — schema ≠ recorded output |
| Live assemble SERV path (`verdict_decide` / `verdict_challenge`) | Live product when key present | Real when `SERV_API_KEY` set | Unchanged |
| `fixtures/serv/recordings/verdict-revision.latest.json` | Sample replay when present | **Must be live-recorded** | Recorder: `npm run eval:record-serv-revision` (not run in this PR) |

## Other fixtures that can look like product evidence

| Item | Shown to users/jury? | Real or written? | Action |
|------|----------------------|------------------|--------|
| `fixtures/autodev-camry.json` | Yes (sample economics on `/report/sample`) | **Real Auto.dev listing payload**, used as an **explicitly labeled sample** (not a SERV transcript) | **Keep** — labeled `sample: true`; not claimed as SERV |
| `fixtures/fueleconomy/*` | Indirect (fuel lookups / tests) | Cached/mirrored FuelEconomy.gov responses for tests & offline matching | **Keep** — not SERV; not shown as agent verdicts |
| `fixtures/scout/pr63-placeholder-ledger.json` | Eval/compare artifacts only | Sanitized scout ledger for model-compare harness | **Keep** — scout eval, not sample SERV trail |
| `fixtures/scout/adversarial-contradiction.json` | No (tests/eval) | Written adversarial scout case | **Keep** (test/eval only) |
| `fixtures/listing-pages/*` | No (fetch/parser tests) | Saved HTML for listing-page parsers | **Keep** (test-only) |
| `eval/results/verdict-latest.json` | Eval docs | **Stub** `status: not_yet_run` — no fabricated scores | **Keep** (honest stub) |
| `eval/results/serv-proof-trace.json` | Eval / judge materials | **Live SERV** flip_judge call with response id + disclosure that it is an evaluation fixture, not customer traffic | **Keep** — real capture with provenance; not a verdict revision trail |
| `eval/results/scout-baseline.json` | Eval | Offline scout plumbing — labeled MOCK/OFFLINE | **Keep** with existing labeling |
| `eval/results/serv-scout-model-compare.*` | Eval | Dry-run / live compare artifacts with gates | **Keep** — harness docs already forbid inventing rows |
| `docs/judge-guide.md` sample link | Jury | Points at labeled sample report | Unchanged; sample no longer invents SERV revision |

## Provenance required for any future sample trail

- `recordedAt` (ISO timestamp)
- `model`
- Raw request + raw response for first, revised, and challenge calls
- OpenServ response ids when the API returns them (`openserv.responseId`)
- `allowedEvidenceIds` from the same facts payload
- `provenance` naming the live recorder (`npm run eval:record-serv-revision`)
- First and revised verdicts must differ (no-op recordings are refused)
