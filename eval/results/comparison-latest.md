# Lemonless vs plain AI vs price sort

**Mode:** fixture (deterministic captured inputs). Generated 2026-11-09T21:42:21.770Z.

Reproducible jury harness: **10 Find queries** + **10 Check listings** (SOLD, far-below market, salvage/rebuilt, high miles, missing VIN, recalls, odometer, as-is/accident). Three arms see identical captured JSON — A) Lemonless domain pipeline (+ SERV in live mode), B) single plain LLM call, C) cheapest-price sort.

Fixture mode never opens the network. Live mode is gated by `COMPARISON_ALLOW_PAID=1` + `SERV_API_KEY` (optional `COMPARISON_DRY_RUN=1` forces offline).

## Totals

| Arm | Cases | Picked SOLD | Picked avoid | Invented $ | Avg |fair−label| | Red-flag recall | Avg latency | Cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| lemonless | 20 | 0 | 2 | 0 | 983 | 0.889 | 2ms | 0 |
| plain_llm | 20 | 3 | 9 | 16 | 2660 | 0.143 | 1ms | 0 |
| cheapest | 20 | 2 | 8 | 0 | 0 | 0.077 | 0ms | 0 |

## What each column means

- **Picked SOLD** — Find: pick VIN is labeled sold. Check: treated a SOLD listing as still buyable.
- **Picked avoid** — Find pick is in `expectedAvoidVins` (title brand, fleet/accident bait, etc.).
- **Invented $** — any dollar/number in the arm text not present in the captured inputs.
- **Avg |fair−label|** — absolute error vs fixture fair-value labels when the arm stated a fair value.
- **Red-flag recall** — fraction of labeled red-flag ids the arm surfaced.

## Vivid cases

### Family SUV around $15k near 68114 (`find-family-suv-15k-68114`)

- **lemonless** → pick `2HKRM4H75FH123456`, verdict `above`, flags [5J6RM4H5XEL999001:sold, sold, accident]. sold=false invented$=false flags 1/1. Lemonless pick 2015 Honda CR-V (medium). The best choice may change as checks complete. Public safety records: 4 models not checked yet. Recall and crash-test data are per model and year, not for this exact car.
- **plain_llm** → pick `5J6RM4H5XEL999001`, verdict `far_below`, flags [—]. sold=true invented$=true flags 0/1. Grab the $7995 CR-V — great deal at about $14000 market.
- **cheapest** → pick `5J6RM4H5XEL999001`, verdict `fair`, flags [sold]. sold=true invented$=false flags 1/1. Cheapest ask: 2014 Honda CR-V at $7995.

### SOLD Camry still listed (`check-sold-camry`)

- **lemonless** → pick `none`, verdict `unknown`, flags [sold]. sold=false invented$=false flags 1/1. 2015 Toyota Camry ask $11990. Walk away until title/availability is cleared.
- **plain_llm** → pick `4T1BF1FK5FU111111`, verdict `fair`, flags [—]. sold=true invented$=false flags 0/1. Fairly priced Camry — good daily driver at $11990.
- **cheapest** → pick `4T1BF1FK5FU111111`, verdict `fair`, flags [—]. sold=true invented$=false flags 0/1. Cheapest-price arm on a single listing: ask $11990.

### Salvage / rebuilt title language (`check-salvage-rebuilt`)

- **lemonless** → pick `3FA6P0H70GR333333`, verdict `far_below`, flags [title_brand, too_good_price]. sold=false invented$=false flags 1/1. 2016 Ford Fusion ask $7495. Walk away until title/availability is cleared.
- **plain_llm** → pick `3FA6P0H70GR333333`, verdict `below`, flags [—]. sold=false invented$=true flags 0/1. Fusion under market — solid commute car.
- **cheapest** → pick `3FA6P0H70GR333333`, verdict `far_below`, flags [—]. sold=false invented$=false flags 0/1. Cheapest-price arm on a single listing: ask $7495.

## How to re-run

```bash
# Offline / CI (default — no network, no credits)
npm run eval:comparison

# Live (parent only — spends SERV on plain LLM + Lemonless SERV pass)
COMPARISON_ALLOW_PAID=1 SERV_API_KEY=… npm run eval:comparison
```

Expected live cost: ~20 plain-LLM calls + ~20 Lemonless `verdict_decide` calls on `gpt-5.4-mini` ≈ **$0.40–$2.00** depending on prompt size (cost fields stay null unless usage is reconciled).

Fixtures: `eval/comparison/fixtures/find-cases.json`, `check-cases.json`.

