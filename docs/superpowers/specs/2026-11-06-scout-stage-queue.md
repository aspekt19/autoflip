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

## STAGE1B-RECOVERY-FOLLOWON — queued AFTER Stage2B (before release)

1. **Live overlap false-dead:** mid-run other facade sees `recovery_needed` “interrupted
   before finish” though owner about to complete → return non-terminal `in_progress`/uncertain
   honestly, not falsely dead. No heartbeat / No TTL reclaim.
2. **`saveScoutRun` swallows Kv write** (`store.ts` ~26–33): SUCCESS ack without durable row →
   second facade recovery_needed. Do not ack durable success unless row persisted;
   truthful `persist_failure`/uncertain; no re-exec. Tests: sequential transient + active concurrency.

## STAGE2A — PIN 680b59a (confirmed)

Directions / first-failure-continue / geo v2 / session v2 / economics-unknown / memory backend.

## STAGE2A-FOLLOWON — PIN 3a6f90b (confirmed; ledger closed)

304 tests/tsc/build; REAL shared monthly ledger (899→200+429, key 900, one stub fetch,
memory counters 0); cache-hit no-charge; pure failure statuses; shared-store copy; strict named
skip; preferLive hash. **Do not rewrite ledger.**

## STAGE2A-FOLLOWON-RESIDUE — queued AFTER Stage2B (copy/UI; ledger stays)

Mixed zero-rows: successful EMPTY + TIMEOUT → 200 `empty_inventory` partialFailure but UI
shows only “No listings…” + widen/loosen filters; timed-out models labeled “Live models checked”;
queryOutcomes not rendered; matchMessage blocks non-exhaustive warning.

Need: explicit PARTIAL/INCOMPLETE_SEARCH (unknown coverage for failed models); no confirmed-empty
market / filters-first when failures present; attempted vs successfully checked; HTTP 200 OK if
clearly partial. Tests: mixed empty+timeout and empty+quota headline/nextStep/models; no rows;
partial nonempty unaffected.

## STAGE2B — THIS bounded run (genuine autonomy — priority; do not interrupt)

- Actual tool outcomes (gov/inventory.search unsupported ≠ cache-success)
- Real replace acquisition of distinct candidate within budget
- Planner receives tool feedback; can replan/reject/replace/stop under deterministic constraints
- Offline full-loop tests: decisions change with evidence; honest fewer/none
- scout_plan transport stays real; offline claim honest (`autonomyClaim=none`)
- No invented title/history tools; unknown investigation allowed, no fake pass

## STAGE3 — queued (honest metrics — not SERV quality from stubs)

Eval tautologies (`claimsSafeBuy` always 0, `insufficientEvidenceInvestigated`,
`realSourceAvailable` const, `rejectReplaceCovered`, mock≠efficacy).

## Ops

Console ~$24.16 visible — no max-cost/reserve verified. **NO paid calls this unit** (parent
stream owns spend). No Graph/merge/deploy/secrets/model settings. Branding retained.
