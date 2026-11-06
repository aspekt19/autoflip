# Verdict decision eval

Status: **not yet run** (2026-11-06T13:44:21.845Z).

SERV_API_KEY was missing, so no live model calls were made and no accuracy percentages were invented.

Offline coverage: `src/domain/verdict-guardrails.test.ts` mocks SERV for each hard guardrail (title brand, park-it, odometer, price-above-market, VIN conflict, thin comps, timeout fallback).

When a key is available: `npm run eval:verdict` writes measured plain-vs-SERV rows for the `verdict_decide` cases in `src/domain/eval-cases.ts`.
