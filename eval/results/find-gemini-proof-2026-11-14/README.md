# Denver Find vs Gemini Auto — Proof evidence

This folder contains the curated evidence used by the public Proof page for the Denver AWD SUV comparison.

## Scenario

Exact request: an AWD SUV near Denver 80202, $25,000 all-in, under 100,000 miles, with winter, child-safety and fuel-cost priorities.

## Lemonless Find capture

- Run ID: `run_2e88e0fb64f74f818f31`
- Find backend run started: `2026-11-13T20:29:50.989Z`
- Completed: `2026-11-13T20:30:38.498Z`
- Result: one specific 2021 Subaru Forester Premium AWD listing, VIN `JF2SKAJC5MH423912`, $20,197, 89,215 miles, Longmont CO, 28 miles from Denver.
- Offer: $19,000 opening offer before tax/fees; $20,000 vehicle-price walk-away; $25,000 all-in ceiling.
- SERV usage: 8 calls, 13 tool calls, 88,084 total tokens (47,059 cached). The provider did not return a dollar-cost figure.

The test exercised the same server-side implementation as the product Find chat. It used an isolated in-memory session, charged no Lemonless credits, and did not mutate production data.

## Gemini capture

The complete answer was supplied by the user from Google Gemini Chat in **Auto** mode. The underlying model chosen by Auto and the exact generation timestamp were not available in the captured material. The original shared conversation is linked in the Proof data.

## Files

- `../find-gemini-proof-2026-11-14.json`: structured comparison data rendered by the Proof page.
- `../find-gemini-chat-auto-2026-11-14.md`: full captured Gemini answer.
  
## Scope

This is one case study, not a statistically general benchmark. It compares the specificity and workflow of the actual responses: a live inventory-backed recommendation versus model-level conversational buying guidance. The Gemini answer was manually captured from the web chat; no API/model identity is asserted.
