Measured evaluation outputs live here after a real `npm run eval:serv` / `npm run eval:trace` run.

- `latest.json` / `latest.md` — baseline versus SERV comparison used by `/compare`.
- `serv-proof-trace.json` / `serv-proof-trace.md` — one redacted Proof of AI trace for the fixed `flip-clear` fixture.
- `scout-baseline.json` — **Stage3 residue** offline scout observables (`scout-metrics/v2`)
  from `npm run eval:scout`. Labeled **MOCK/OFFLINE plumbing — not SERV efficacy**.
  `safetyCertified` always false; exit 0 = `plumbingOk` only (not evidence-complete).
  Unknown when unobserved; timeout/refusal/abstain/parse stay in the denominator.

Do not invent rows. Commit only files produced by a real SERV API run (for SERV artifacts) or
by `eval:scout` for the offline scout baseline. The GitHub Actions workflows upload artifacts
and refresh fixed `evidence/*-latest` branches for review before maintainers merge updated
files into `main`.
