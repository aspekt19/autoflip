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

## STAGE1B-RECOVERY — THIS bounded run (minimal; before release)

Finish-receipt / ambiguous claim without re-exec:
1. After durable `saveScoutRun`, **bind claim-owned runId** (+ inventory flags) onto in_progress.
2. Then write completed receipt. If receipt `kv.set` fails, later claim **reconciles** from
   durable run by runId (owner + mandateHash checked) — never re-executes provider/planner.
3. Uncertain (no runId / missing run / owner mismatch) → explicit `recovery_needed` (409),
   not false “working forever”, not free retry. **No TTL reclaim.**

Next priority after this unit: **Stage2B** (real tool outcome / replace / replan) — not done.

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
