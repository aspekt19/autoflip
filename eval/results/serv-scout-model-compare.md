# SERV scout model compare (PR63 placeholder ledger)

- Mode: `dry_run`
- Harness head (when committed): see git SHA on PR branch
- Ledger: `fixtures/scout/pr63-placeholder-ledger.json`
- Deployed SHA under test (ledger): `de5eb0c0dab6d394765ff5916abf6346dc139841`
- Production default model: `gpt-5.4-mini` (unchanged: true)
- Cost: **unknown** (console $/M is not reconciled run cost; labeled costunknown)

## Critical disclaimers (t294/t295)

- **Model-only swap is NOT the demonstrated product fix** for the placeholder-price reject deadlock. Code fixes (query floor, cite grounding, filter) are separate; this harness only compares planner behavior on the same offline ledger input.
- **Budget-conscious ≠ cheapest.** Do not pick the lowest console $/M at the expense of grounded recovery / anti-loop quality.
- **Console ≠ in-repo catalog.** Console Available-models is broader (e.g. `gpt-6-luna`); unlisted IDs need parent validation + `SCOUT_COMPARE_ALLOW_UNLISTED=1`.
- **Zero-network default.** Live requires `SERV_API_KEY` + `SCOUT_COMPARE_ALLOW_PAID=1`.

## Evidence taxonomy (observed vs hypotheses vs unrecorded)

### Observed
- Run ff52a261 on deployed de5eb0c: state failed, failReason budget_exhausted with message Repeated identical planner action (reject:4TAWM72N3WZ162673:adverse_evidence) 3 times.
- maxServCalls=null (unmetered SERV call-count); stop was no-progress protection, not a three-call SERV quota.
- inventory.search success: 20 live listings; provenance price=1-20000,distance=nationwide; sort=price in live adapter.
- All 20 observedPrices in [$1,$59]; firstCandidate price qualification unknown below usable retail floor ($500).
- Two candidate.reject outcomes ok=false with reject_rationale_not_grounded for citedEvidence missing_asking_price@price.
- No government tool outcomes; investigation empty; all candidates remained pending; persistent GET equaled POST result.

### Hypotheses (not proven as sole root cause)
- price=1-N + sort=price fills Auto.dev limit:20 with cheapest placeholder asks (supported by query construction + observed ladder; not a claim Auto.dev lacks usable Toyota asks under $20k).
- Planner invented gateId price from constraintQualification.price field name while adverse fact omitted gateId (pre-fix matching required exact gateId when cited).
- With fixed grounding + usable price floor, planner can reject/search/abstain instead of no-progress — model-only swap is NOT the demonstrated product fix.

### Unrecorded historical details
- Full raw SERV planner response/action objects and complete citedEvidence arrays for every step (esp. step-3) were not stored in the sanitized 07/08/09 files.
- Exact Auto.dev JSON row fields beyond mapped retail.price/record.price for the 20 VINs were not retained in the handoff.
- Independent HTTP/billing reconciliation of SERV/Auto.dev spend (cost remains unknown).
- Whether a mid-loop inventory.search with floor 500 would have returned usable asks on that exact minute (not live-retested by Cursor).

## Offline before / after (reproduction)

- **Before (de5eb0c live / offline replay):** On de5eb0c, missing_asking_price@price reject was deny→deny→identical fingerprint no-progress stop; pool was 20 placeholder asks under price=1-20000 + sort=price.
- **After code fix (this branch, offline):** Offline regression: same citation grounds; query floor 500-N; placeholders filtered under priced search; abstain/search recovery paths score cleanly. See placeholder-price-recovery.regression.test.ts.
- **Model compare role:** Optional parent sequential SERV compares on SAME offline ledger inputs — not proof that changing BASE_MODEL alone fixes production.

## Catalog mechanism

```
In-repo catalog (default; production BASE_MODEL unchanged):
  - gpt-5.4-mini (src/server/serv/profiles.ts BASE_MODEL + README SERV_MODEL default); scout_plan effective=gpt-5.4-mini
  - gpt-5.4-mini-2026-03-17 (eval/results/latest.json + eval/results/serv-proof-trace.json reported model); scout_plan effective=gpt-5.4-mini-2026-03-17
Console vs catalog: OpenServ console Available-models table is broader (e.g. gpt-6-luna and other tiers with $/M rates). Those IDs are NOT auto-allowlisted here — no scrape, no hardcoded availability/schema claim, no cheapest-forced pick.
Unlisted IDs: SERV_COMPARE_MODELS=… + SCOUT_COMPARE_ALLOW_UNLISTED=1 after parent console/contract validation (fail-closed otherwise).
Budget-conscious ≠ cheapest-at-expense-of-quality — compare recovery/groundedness, not rate-table shopping.
Model-only swap is NOT the demonstrated fix for the PR63 placeholder-price reject deadlock.
```

## Historical labeled actions (offline)

- step-1 (live_denied_reject_missing_asking_price_at_price): observedOk=false; recovery=grounded_reject_unusable_ask; grounded=true; antiLoopSafe=false
- step-2 (live_denied_reject_repeat): observedOk=false; recovery=grounded_reject_unusable_ask; grounded=true; antiLoopSafe=false

Note: `observedOk=false` is the **historical live** denial on de5eb0c; `grounded=true` under current code reflects the cite-grounding fix on the same citation shape — not a claim the live run was grounded.

## Model × step rows

_No live model rows (dry-run)._

## Remaining limits

- Not live-tested by Cursor; parent is sole live coordinator.
- Cost remains unknown until central reconciliation (console $/M ≠ receipt).
- Unlisted console IDs are not availability/schema guarantees even with ALLOW_UNLISTED.
- Full raw step-3 planner payloads were unrecorded in the sanitized handoff.
- Whether Auto.dev returns usable asks after 500-N on a given minute is unproven here.
