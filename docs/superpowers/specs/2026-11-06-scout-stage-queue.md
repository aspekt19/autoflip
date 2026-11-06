# Scout / Find review stages — queue (do not silently drop)

writtenAt_utc: 2026-11-06
constraints: no spend / secrets / deploy / merge / Graph / model change. No self-release approval.
Stage1 PIN `d8187b8` independently confirmed — **not full release / not $5 proof**.
Stage1B PIN `ad5f9f7` / `f0613230133e0cf3c42b16eb6c3903989` independently confirmed for listed safety subset.
Stage2A PIN `680b59a` independently confirmed for listed subset — follow-on gaps expected at pin, not regressions.

## STAGE1 — PIN d8187b8 (confirmed subset)

Confirmed: durable monthly seed, non-numeric reject, env balance cannot grant, 0-budget 0-fetch,
cache monthly refund, per-make ceiling, HTTP/SDK no injected grant.
Follow-on: `/find` shared-store fail-closed (`494e771`).

## STAGE1B — PIN ad5f9f7 (confirmed subset)

Confirmed: durable NX claim before work / no TTL; separate facades overlap → one execution / 409 /
replay; owners isolated / mandate conflict; serverless Memory block 0-fetch; mid-flight abort +
timeout with reservation retained. Safety closure strong; 292 tests ≠ full availability closure.

**Hash semantics (verified this turn):** claim binds stripped mandate + effective `planner` +
`preferLive`. Client spend/budget fields stay stripped (never authorize, must not fork the key).
Different preferLive/planner must not silently replay — result meaning changes (fixture vs live;
heuristic vs SERV).

## STAGE1B-RECOVERY — queued AFTER Stage2A-followon (before release; do not broaden safety forever)

Partial finish-write gap: if final durable receipt `kv.set` throws after run completed, claim stays
`in_progress` and callers 409 forever despite a completed run. Same if SET NX claim lands then
response path errors mid-flight. **Deliberately no TTL / no auto-rerun** — correct spend safety.

Minimal design (investigate at recovery unit — not this turn):
1. On claim proceed, record claim-owned `runId` (or bind after runId minted) on the durable claim
   **before** returning the HTTP response when possible.
2. Recovery path: owner-guarded load of completed run/receipt by that reference; rewrite durable
   completed receipt **without re-executing** any scout/provider work.
3. If run presence / ownership / mandate-hash is uncertain → keep non-executing status named
   `recovery_needed` (not falsely “working forever”, not free retry).
4. Observability: metric/log when complete-write fails after run; operator can finish receipt.

Do **not** invent TTL reclaim that re-runs expensive work. Keep Stage2B/3 moving after follow-on.

## STAGE2A — PIN 680b59a (confirmed subset)

Confirmed: core directions / first-failure-continue / geo cache v2 / session v2 /
economics-unknown / memory-backend block. Gaps below were expected at pin.

## STAGE2A-FOLLOWON — THIS bounded run

1. All Autodev fail/timeout/demo_limit ≠ `empty_inventory` 200; genuine empty only after ≥1
   successful provider response; distinct HTTP/copy.
2. Persistent `reserve` through `assembleRadar` → `autodevSearch`; incr before fetch; cache-hit
   no re-charge; parallel instances share cap; `shared_store_required` truthful 503.
3. planned / searched / skipped models; closed mandate = named only (no editorial Camry).

## STAGE2B — queued NEXT (real autonomy — not completed by tests)

- Gov unsupported / `inventory.search` no-op cached-as-success
- `replace` only relabels — real next-candidate load + planner feedback
- Missing planner-context tool bodies/steps for dynamic replan
- Typed next-action execution feedback

## STAGE3 — queued

Eval tautologies (`claimsSafeBuy` always 0, `insufficientEvidenceInvestigated`,
`realSourceAvailable` const, `rejectReplaceCovered`, mock≠efficacy).

## Ops note (read-only)

Console ~$24.16 visible — no max-cost/reserve control verified. **NO paid-calls permission
change.** Main writer does not touch console keys/settings.

## Retained

- Real `scout_plan` HTTP markers/schema (not `Agent.process()`)
- Client budget/spend strip; Stage1 durable quota / non-bypass paid scout
- Unknown≠pass; unknown history still allows investigation
- Consumer English; Orbitron / branding — no nav/design redo
