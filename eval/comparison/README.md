# Comparison harness

Honest **Lemonless vs plain AI vs cheapest-price sort** on the same captured inputs.

## Honesty rules

- Offline / CI: **code arms only**. `plain_llm` is always `not_run` — canned answers are forbidden.
- No scoreboard in docs until a **live** run writes real totals.
- Scoring `labels` (fair value, expected flags) are **never** passed into arms.
- Current fixtures are **synthetic** (harness-authored VINs) with `labels.provenance` from production `evaluateListingPrice` / `listingRedFlags`. Prefer real captures over time; real vs synthetic totals are reported separately after a live run.
- Live Lemonless uses production `runCheck` / `selectBestDealOnEvidence` + SERV `verdict_decide` + `verdict_challenge`.
- Live plain_llm sees the **identical shared payload** (no labels). Model id, timestamp, prompt, and raw response are saved under `eval/results/comparison-live/`.

## Commands

```bash
# Offline / CI (default) — no network, no credits
npm run eval:comparison

# Rebuild synthetic label provenance from production modules
npx tsx eval/comparison/rebuild-fixture-labels.ts

# Live (parent only)
COMPARISON_ALLOW_PAID=1 SERV_API_KEY=… npm run eval:comparison
```

Writes:

- `docs/eval/comparison.md` (fixture: harness-ready, no scoreboard; live: scored table)
- `eval/results/comparison-latest.json`
- `eval/results/comparison-latest.md`

## Expected live cost

~20 plain-LLM chat completions + ~20 Lemonless SERV (`verdict_decide` + `verdict_challenge`) on `gpt-5.4-mini` ≈ **$0.40–$2.50**. Site report credits are not spent.
