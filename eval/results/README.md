Measured evaluation outputs live here after a real `npm run eval:serv` / `npm run eval:trace` run.

- `latest.json` / `latest.md` — baseline versus SERV comparison used by `/compare`.
- `serv-proof-trace.json` / `serv-proof-trace.md` — one redacted Proof of AI trace for the fixed `flip-clear` fixture.
- `scout-baseline.json` — **Stage3 residue** offline scout observables (`scout-metrics/v2`)
  from `npm run eval:scout`. Labeled **MOCK/OFFLINE plumbing — not SERV efficacy**.
  `safetyCertified` always false; exit 0 = `plumbingOk` only (not evidence-complete).
  Unknown when unobserved; timeout/refusal/abstain/parse stay in the denominator.
- `serv-scout-model-compare.json` / `.md` — **owner t292/t294/t295** controlled SAME-input
  SERV-model comparison on the sanitized PR63 placeholder ledger
  (`fixtures/scout/pr63-placeholder-ledger.json`, includes `evidenceTaxonomy`).
  Harness: `npm run eval:scout-model-compare`.
  - **Zero-network default** (dry-run). Live: `SERV_API_KEY` + `SCOUT_COMPARE_ALLOW_PAID=1`.
  - Optional `SERV_COMPARE_MODELS`; unlisted console IDs need `SCOUT_COMPARE_ALLOW_UNLISTED=1`
    after parent console/contract validation (fail-closed otherwise; no blind allowlist expand).
  - **Fair slate (t317):** `SCOUT_COMPARE_FAIR_SLATE=1` → docs IDs
    `gpt-5.4-mini`, `claude-sonnet-4.6`, `gemini-2.5-flash` (Flip confirms console enablement).
  - **Sequential XOR:** `SCOUT_COMPARE_SEQUENTIAL=1` + paid gates → ≤2 HTTP D1→apply→D2 only
    (normal compare skipped — see `compare-cli-dispatch.ts`).
  - Captures validity, groundedness, recovery, latency, tokens, **costunknown**.
  - Parse/transport failures also record **sanitized** diagnostics only:
    `sanitizedPlannerEcho` (keys/types/lengths — never raw planner JSON),
    `upstreamResponseId` / `finishReason` when present on proof, and `responseShape`.
  - Live path uses **`experiment_single_attempt`**: one upstream HTTP per scout_plan step;
    empty/timeout/HTTP errors/refusals are recorded (not silently re-POSTed). Production
    `runServ` empty/timeout recovery is unchanged outside this harness. No arbitrary SERV
    run quota — honest timeout (45s) + output-token (default 4096) bounds only.
  - **Model-only swap is NOT the demonstrated product fix**; production `BASE_MODEL` unchanged.
  - **Budget-conscious ≠ cheapest.** Console Available-models (e.g. `gpt-6-luna` + $/M rates)
    is broader than the in-repo catalog — document discrepancy; do not hardcode availability.
  - Artifact markdown includes observed vs hypotheses vs unrecorded + offline before/after handoff.
- `serv-compare-preflight.md` — offline Flip instructions + protocol issues
  (`npm run eval:serv-compare-preflight`; zero network).

Do not invent rows. Commit only files produced by a real SERV API run (for SERV artifacts) or
by `eval:scout` / dry-run `eval:scout-model-compare` for offline scout artifacts. The GitHub Actions workflows upload artifacts
and refresh fixed `evidence/*-latest` branches for review before maintainers merge updated
files into `main`.
