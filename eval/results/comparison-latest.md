# Lemonless vs plain AI vs price sort

**Mode:** fixture / harness ready. Generated 2026-11-09T22:06:52.911Z.

**No scoreboard yet.** Fixture mode does not publish totals, invented-dollar counts, or vivid case winners — those numbers would be fabricated without a live plain-LLM run.

## What this harness compares

| Arm | Offline | Live |
|-----|---------|------|
| **lemonless** | Production domain modules only (`selectBestDealOnEvidence`, `evaluateListingPrice`, `listingRedFlags`) | Same captured listings, then production `verdict_decide` + `verdict_challenge` (`verdictDecisionFacts`, `resolveVerdictDecision`, `runReportVerdictChallenge`) |
| **plain_llm** | **not run** (canned answers forbidden) | One chat completion on the **identical shared payload** |
| **cheapest** | Sort by ask | Same |

Both arms see `sharedFindPayload` / `sharedCheckPayload` (no `fixture.labels`). Lemonless SERV also receives production `verdictDecisionFacts` (code fair value and gates). Shared model id: `gpt-5.4-mini`.

## Cases

- Find: 10 (0 real-sourced / 10 synthetic)
- Check: 10 (0 real-sourced / 10 synthetic)

### Case list

- `find-family-suv-15k-68114` (synthetic, find) — plain_llm: **not_run** — plain_llm not run in fixture mode — canned answers are forbidden. Run live with COMPARISON_ALLOW_PAID=1.
- `find-commuter-sedan-12k` (synthetic, find) — plain_llm: **not_run** — plain_llm not run in fixture mode — canned answers are forbidden. Run live with COMPARISON_ALLOW_PAID=1.
- `find-teen-first-car-8k` (synthetic, find) — plain_llm: **not_run** — plain_llm not run in fixture mode — canned answers are forbidden. Run live with COMPARISON_ALLOW_PAID=1.
- `find-awd-winter-18k-msp` (synthetic, find) — plain_llm: **not_run** — plain_llm not run in fixture mode — canned answers are forbidden. Run live with COMPARISON_ALLOW_PAID=1.
- `find-low-mile-camry-20k` (synthetic, find) — plain_llm: **not_run** — plain_llm not run in fixture mode — canned answers are forbidden. Run live with COMPARISON_ALLOW_PAID=1.
- `find-truck-weekend-22k` (synthetic, find) — plain_llm: **not_run** — plain_llm not run in fixture mode — canned answers are forbidden. Run live with COMPARISON_ALLOW_PAID=1.
- `find-hybrid-fuel-16k` (synthetic, find) — plain_llm: **not_run** — plain_llm not run in fixture mode — canned answers are forbidden. Run live with COMPARISON_ALLOW_PAID=1.
- `find-luxury-stretch-25k` (synthetic, find) — plain_llm: **not_run** — plain_llm not run in fixture mode — canned answers are forbidden. Run live with COMPARISON_ALLOW_PAID=1.
- `find-city-crossover-14k` (synthetic, find) — plain_llm: **not_run** — plain_llm not run in fixture mode — canned answers are forbidden. Run live with COMPARISON_ALLOW_PAID=1.
- `find-cheapest-reliable-honda-33101` (synthetic, find) — plain_llm: **not_run** — plain_llm not run in fixture mode — canned answers are forbidden. Run live with COMPARISON_ALLOW_PAID=1.
- `check-sold-camry` (synthetic, check) — plain_llm: **not_run** — plain_llm not run in fixture mode — canned answers are forbidden. Run live with COMPARISON_ALLOW_PAID=1.
- `check-far-below-market` (synthetic, check) — plain_llm: **not_run** — plain_llm not run in fixture mode — canned answers are forbidden. Run live with COMPARISON_ALLOW_PAID=1.
- `check-salvage-rebuilt` (synthetic, check) — plain_llm: **not_run** — plain_llm not run in fixture mode — canned answers are forbidden. Run live with COMPARISON_ALLOW_PAID=1.
- `check-high-mileage` (synthetic, check) — plain_llm: **not_run** — plain_llm not run in fixture mode — canned answers are forbidden. Run live with COMPARISON_ALLOW_PAID=1.
- `check-missing-vin` (synthetic, check) — plain_llm: **not_run** — plain_llm not run in fixture mode — canned answers are forbidden. Run live with COMPARISON_ALLOW_PAID=1.
- `check-fair-camry` (synthetic, check) — plain_llm: **not_run** — plain_llm not run in fixture mode — canned answers are forbidden. Run live with COMPARISON_ALLOW_PAID=1.
- `check-overpriced-dealer` (synthetic, check) — plain_llm: **not_run** — plain_llm not run in fixture mode — canned answers are forbidden. Run live with COMPARISON_ALLOW_PAID=1.
- `check-recall-heavy` (synthetic, check) — plain_llm: **not_run** — plain_llm not run in fixture mode — canned answers are forbidden. Run live with COMPARISON_ALLOW_PAID=1.
- `check-odometer-rollback` (synthetic, check) — plain_llm: **not_run** — plain_llm not run in fixture mode — canned answers are forbidden. Run live with COMPARISON_ALLOW_PAID=1.
- `check-as-is-accident` (synthetic, check) — plain_llm: **not_run** — plain_llm not run in fixture mode — canned answers are forbidden. Run live with COMPARISON_ALLOW_PAID=1.

## Labels

Scoring labels live on each fixture under `labels` with a `provenance` block. They are derived from captured comps via `evaluateListingPrice` / from listing text via `listingRedFlags` + sold/VIN heuristics — **not** hand-picked winners. Arms never read `labels`.

## How to run live (parent only)

```bash
COMPARISON_ALLOW_PAID=1 SERV_API_KEY=… npm run eval:comparison
```

Expected live cost: ~20 plain-LLM + ~20 Lemonless SERV (`verdict_decide` + second pass) on `gpt-5.4-mini` ≈ **$0.40–$2.50**. No site report credits. Traces land in `eval/results/comparison-live/`.

After a live run, this file and `eval/results/comparison-latest.*` gain a scored table with **real** and **synthetic** rows reported separately.

Fixtures: `eval/comparison/fixtures/find-cases.json`, `check-cases.json`.

