# Comparison harness

Honest **Lemonless vs plain AI vs cheapest-price sort** on the same captured inputs.

## Commands

```bash
# Offline / CI (default) — no network, no credits
npm run eval:comparison

# Live (parent only)
COMPARISON_ALLOW_PAID=1 SERV_API_KEY=… npm run eval:comparison
```

Writes:

- `docs/eval/comparison.md` (jury-readable table + case write-ups)
- `eval/results/comparison-latest.json`
- `eval/results/comparison-latest.md`

## Expected live cost

~20 plain-LLM chat completions + ~20 Lemonless `verdict_decide` SERV calls on `gpt-5.4-mini` ≈ **$0.40–$2.00**. Site report credits are not spent.
