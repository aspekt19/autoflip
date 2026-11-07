Measured evaluation outputs live here after a real `npm run eval:serv` / `npm run eval:trace` run.

- `latest.json` / `latest.md` — baseline versus SERV comparison used by `/compare`.
- `serv-proof-trace.json` / `serv-proof-trace.md` — one redacted Proof of AI trace for the fixed `flip-clear` fixture.
- `scout-baseline.json` — **Stage3 residue** offline scout observables (`scout-metrics/v2`)
  from `npm run eval:scout`. Labeled **MOCK/OFFLINE plumbing — not SERV efficacy**.
  `safetyCertified` always false; exit 0 = `plumbingOk` only (not evidence-complete).
  Unknown when unobserved; timeout/refusal/abstain/parse stay in the denominator.
- `serv-scout-model-compare.json` / `.md` — **owner t292** controlled SAME-input SERV-model
  comparison on the sanitized PR63 placeholder ledger (`fixtures/scout/pr63-placeholder-ledger.json`).
  Harness: `npm run eval:scout-model-compare`. Dry-run by default (no spend). Live mode requires
  parent `SERV_API_KEY` + `SCOUT_COMPARE_ALLOW_PAID=1` + optional `SERV_COMPARE_MODELS`.
  Captures validity, groundedness, recovery class, latency, tokens, **costunknown**.
  Does **not** change production `SERV_MODEL` / `BASE_MODEL`. Model IDs from in-repo catalog only
  (`src/server/serv/model-catalog.ts`).

Do not invent rows. Commit only files produced by a real SERV API run (for SERV artifacts) or
by `eval:scout` / dry-run `eval:scout-model-compare` for offline scout artifacts. The GitHub Actions workflows upload artifacts
and refresh fixed `evidence/*-latest` branches for review before maintainers merge updated
files into `main`.
