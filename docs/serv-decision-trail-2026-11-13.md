# SERV decision trail — recorded Find run (13 November 2026)

This file is generated from the committed Proof artifact
[`eval/results/find-gemini-proof-2026-11-13.json`](../eval/results/find-gemini-proof-2026-11-13.json).
It restates only fields present in that JSON. It is not a live SERV replay.

## What this trail is

The public [Proof page](https://autoflip-umber.vercel.app/proof) uses this recorded Find run.
The run executed through the same server-side Find path as `/api/find/chat`, with isolated in-memory state (`skipCredit=true`).

## Recorded summary

| Field | Value |
|---|---|
| Recorded at (UTC) | `2026-11-13T20:29:50.989Z` |
| Find run ID | `run_2e88e0fb64f74f818f31` |
| Status | `completed` |
| Started | `2026-11-13T20:29:50.989Z` |
| Finished | `2026-11-13T20:30:38.498Z` |
| Duration | 47509 ms (47.5 s) |
| SERV model | `gpt-6.1-sol` |
| SERV calls | 8 |
| Tool rounds | 12 |
| Application tool calls | 13 |
| Inventory searches | 2 |
| Inventory listings returned | 20 |
| Verdict | `needs_inspection` |
| Confidence | `medium` |
| Credits charged | false |
| Production data changed | false |

### Buyer request (verbatim from the artifact)

> I'm in Denver 80202, budget $25k all-in, need an AWD SUV for mountain winters and a 40-mile daily commute. Two kids, so safety matters most. Under 100k miles, no accident or salvage history, low fuel cost. Within 75 miles. Which one should I buy and what should I offer?

### Selected listing (from `lemonless.pick`)

2021 Subaru Forester Premium AWD · VIN JF2SKAJC5MH423912 · $20,197 asking price · 89,215 miles · Longmont, Colorado · approximately 28 miles from ZIP 80202.

### Recommendation (from `lemonless.recommendation`)

Needs inspection. Opening offer: $19,000 before taxes and fees. Vehicle-price walk-away point: $20,000. Keep the total purchase within the $25,000 all-in budget.

### Evidence notes recorded on the pick

- Live inventory search returned the listing with its VIN, asking price, mileage, seller field, location and listing URL.
- VIN decode: 2021 Subaru Forester Premium, AWD, 2.5L gasoline engine.
- Official vehicle safety lookup: 5-star overall, front and side ratings; 4-star rollover.
- Fuel-economy estimate for the closest configuration: 29 MPG combined and $1,670 standardized annual fuel cost.
- Local 2019–2021 Forester asking-price comparisons: $19,493–$20,197, with a $19,797 median; advertised prices, not completed sale prices.
- Search area: ZIP 80202, within 75 miles; selected listing approximately 28 miles away.

### Unknowns recorded on the pick

- The dealer's final itemized out-the-door amount, including taxes, title, registration and fees, was not part of this result.
- A physical pre-purchase inspection, test drive, tire check and child-seat fit check still need to happen.

### Rejection / caution text recorded

The final Find verdict was needs_inspection with medium confidence. It did not recommend buying immediately; it recommended confirming the vehicle with an in-person inspection and a written out-the-door quote.

### Features listed on the run

- `serv_prompt_guard`
- `content_filter`
- `reasoning_effort`
- `prompt_cache`
- `responses_reasoning`
- `usage`
- `serv_shadow_agent`
- `multipath`
- `kronos`

### SERV response IDs (ordered as stored)

The artifact stores eight SERV response IDs for this run. It does **not** attach each ID to a named tool call, tool arguments, or tool result.

1. `resp_0d1845524b5c558c016af77341a79487d2a369b17ed554771a`
2. `resp_0d1845524b5c558c016af77343e98887d2bfae634f81feb4d6`
3. `resp_0d1845524b5c558c016af773493e0487d2a38af39d8024033f`
4. `resp_0d1845524b5c558c016af7734d904087d2a946f3282681b54b`
5. `resp_0d1845524b5c558c016af773524cd887d2a81a4d21c9e129c0`
6. `resp_0d1845524b5c558c016af77359c8a887d2a4b0e0a568de9d81`
7. `resp_0d1845524b5c558c016af7735e870c87d29cf14707e9a1cb89`
8. `resp_0d1845524b5c558c016af773677cc087d288d23ca41f30b9dd`

### Token usage (as stored)

| Metric | Value |
|---|---:|
| Input tokens | 86368 |
| Output tokens | 1716 |
| Total tokens | 88084 |
| Cached tokens | 47059 |
| Provider cost | None |

## What is not recorded in this artifact

The committed Proof JSON and the related comparison files under `eval/results/compare-2026-11-13/` do **not** include an ordered per-turn decision journal with:

- which application tool SERV chose on each turn,
- a summary of that tool's inputs,
- a summary of that tool's result,
- per-candidate rejection reasons for inventory rows that were considered and discarded, or
- a mapping from each SERV response ID to the tool round that produced it.

`scripts/export-serv-decision-trails.mjs` can export sealed `decision-audit:*` chains from a local `.data/kv.json` store after real runs persist. That local KV file is not present in this checkout, and no sealed per-turn chain for `run_2e88e0fb64f74f818f31` is committed under `eval/results/`. This document therefore does not invent those turns, and no paid live SERV call was made to reconstruct them.

## Related committed files

- [`eval/results/find-gemini-proof-2026-11-13.json`](../eval/results/find-gemini-proof-2026-11-13.json) — Proof page source of truth
- [`eval/results/proof-serv-compare-2026-11-13.json`](../eval/results/proof-serv-compare-2026-11-13.json) — comparison record used by Proof / Where SERV runs
- [`scripts/export-serv-decision-trails.mjs`](../scripts/export-serv-decision-trails.mjs) — exporter for sealed local decision-audit chains (requires `.data/kv.json`)

