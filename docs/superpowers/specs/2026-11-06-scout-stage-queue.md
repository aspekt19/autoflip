# Scout / Find review stages — queue (do not silently drop)

writtenAt_utc: 2026-11-06
constraints: no spend / secrets / deploy / merge / Graph / model change. No self-release approval.

## STAGE1 — PIN d8187b8 (confirmed)

Durable monthly seed, non-numeric reject, env-balance≠grant, 0-budget 0-fetch, cache DECR,
per-make ceiling, no HTTP-injected grant. Follow-on: `/find` shared-store (`494e771`).

## STAGE1B — PIN ad5f9f7 (confirmed)

Durable NX claim before work / no TTL; overlap one execution / 409 / replay; owners isolated;
mandate conflict; serverless Memory block; mid-flight abort+timeout reservation retained.
Hash: stripped mandate + planner + preferLive (spend fields stripped).

## STAGE1B-RECOVERY — PIN 36a56b9 (confirmed landed)

Bind applied then error → replay; no foreign leak; no re-run.

## STAGE1B-RECOVERY-FOLLOWON — THIS residue (a) with Stage2A residue (b)

1. **Live overlap false-dead:** mid-run peer → non-terminal `in_progress` (not falsely dead
   `recovery_needed`). No heartbeat / No TTL reclaim.
2. **`saveScoutRun` durable ack:** fail → `idempotency_persist_failure` / no SUCCESS / claim
   stays `in_progress` without runId; no re-exec.

## STAGE2A — PIN 680b59a (confirmed)

Directions / first-failure-continue / geo v2 / session v2 / economics-unknown / memory backend.

## STAGE2A-FOLLOWON — PIN 3a6f90b (confirmed; ledger closed)

304 tests/tsc/build; REAL shared monthly ledger (899→200+429, key 900, one stub fetch,
memory counters 0); cache-hit no-charge; pure failure statuses; shared-store copy; strict named
skip; preferLive hash. **Do not rewrite ledger.**

## STAGE2A-FOLLOWON-RESIDUE — THIS residue (b) with recovery-followon (a)

Mixed zero-rows → `incomplete_search` (not empty-market / loosen-filter); searchedModels =
successfully checked; failedModels = attempted-not-checked; UI labels both. Ledger untouched.

## STAGE2B — PIN dac59b3 (confirmed 317 tests; PRODUCT not release closure)

Confirmed: adversarial missing-price rejected / overpriced replaced / distinct peer actually
investigated; unknown history withholds; title forbid; claimsSafeBuy false; unsupported gov
replay no-charge tool counts; empty replacement abstain; real recentOutcomes transport.

**Remain PRODUCT gap — do not market 2B as full goal / autonomy:**
- `inventory.search` (~672–689) cannot call adapter again / change make·zip·radius
- heuristic (~969+) still VIN-walk except unsupported/failed/replace-empty
- `recentOutcomes` status+summary ≠ enough evidence facts; evidenceHints limited/investigated
- Unknown or unsupported tool alone is **not** proof the car is bad — do not force replacement
  merely because a gov tool is unavailable

## STAGE3 — PIN (honest eval metrics — schema scout-metrics/v1)

Replace tautologies with observables: candidate claims / evidence provenance / hard gates /
history-unknown / titles / actual reject·replace / tool outcomes / incomplete inventory /
actions + budget + latency. No observations → **unknown** (not 0-safety or perfect).
Perturbation detectors: unsafe-unknown-claim, unsupported-as-success, fake-replacement,
wrong-source, missing-needed-search. Matched baseline overlap labeled MOCK/OFFLINE plumbing
— **not SERV efficacy**. Timeout/refusal/abstain stay in denominator. Residue `6dc1bed`
review stays separate/active. Parent hosted SERV probe = 200/null/0 usage (no action quality);
no Guard-blocked / advantage claim; **NO more paid calls**.

## STAGE2C — queued AFTER Stage3 (bounded; not a new framework)

Real bounded search adjustment within mandate/server caps:
- typed validated search params → fresh results / duplicates / source / geo
- provider + fixture adapters with budget spies (prove actual adapter dispatch with stubs;
  hosted SERV probe = parent only)
- richer bounded facts / missingness / gates / confidence into SERV prompt so feedback can
  choose useful next check / reject / replace / **new search** — not blind VIN-walk
- risk/evidence-directed choices without inventing history data
- No fake autonomy claim; no paid Auto.dev / new expenses this unit

## Ops

Console ~$24.16 visible — no max-cost/reserve verified. **NO paid calls this unit** (parent
stream owns spend). No Graph/merge/deploy/secrets/model settings. Branding retained.
