Measured evaluation outputs live here after a real `npm run eval:serv` / `npm run eval:trace` run.

- `latest.json` / `latest.md` — baseline versus SERV comparison used by `/compare`.
- `serv-proof-trace.json` / `serv-proof-trace.md` — one redacted Proof of AI trace for the fixed `flip-clear` fixture.
- `scout-baseline.json` — **Stage3** offline scout observables (`scout-metrics/v1`) from
  `npm run eval:scout`. Labeled **MOCK/OFFLINE plumbing — not SERV efficacy**. No Guard /
  advantage claim. Unknown when unobserved; timeout/refusal/abstain stay in the denominator.

Do not invent rows. Commit only files produced by a real SERV API run (for SERV artifacts) or
by `eval:scout` for the offline scout baseline. The GitHub Actions workflows upload artifacts
and refresh fixed `evidence/*-latest` branches for review before maintainers merge updated
files into `main`.
