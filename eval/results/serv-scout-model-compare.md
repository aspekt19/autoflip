# SERV scout model compare (PR63 placeholder ledger)

- Mode: `dry_run`
- Ledger: `fixtures/scout/pr63-placeholder-ledger.json`
- Deployed SHA under test (ledger): `de5eb0c0dab6d394765ff5916abf6346dc139841`
- Cost: **unknown** (not reconciled; labeled costunknown)

## Catalog mechanism

```
Supported comparison model IDs are limited to in-repo evidence:
  - gpt-5.4-mini (src/server/serv/profiles.ts BASE_MODEL + README SERV_MODEL default); scout_plan effective=gpt-5.4-mini
  - gpt-5.4-mini-2026-03-17 (eval/results/latest.json + eval/results/serv-proof-trace.json reported model); scout_plan effective=gpt-5.4-mini-2026-03-17
Production default remains BASE_MODEL; this catalog does not swap it.
```

## Historical labeled actions (offline)

- step-1 (live_denied_reject_missing_asking_price_at_price): observedOk=false; recovery=grounded_reject_unusable_ask; grounded=true; antiLoopSafe=false
- step-2 (live_denied_reject_repeat): observedOk=false; recovery=grounded_reject_unusable_ask; grounded=true; antiLoopSafe=false

## Model × step rows

_No live model rows (dry-run)._

Not a production default-model swap. Parent chooses and executes sequential live comparisons.
