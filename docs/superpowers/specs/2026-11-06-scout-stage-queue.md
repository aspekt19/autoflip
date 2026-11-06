# Scout / Find review stages — queue (do not silently drop)

writtenAt_utc: 2026-11-06
constraints: no spend / secrets / deploy / merge / Graph / model change. No self-release approval.
Stage1 PIN `d8187b8` independently confirmed for listed items — **not full release / not $5 proof**.
Stage2A PIN `680b59a` independently confirmed for listed subset — **not** the three follow-on bugs below.

## STAGE1 — PIN d8187b8 (independent review confirmed subset)

Confirmed: durable monthly seed, non-numeric reject, env balance cannot grant, 0-budget 0-fetch,
cache monthly refund, per-make ceiling, HTTP/SDK no injected grant.
**Not** claimed: full release, $5 reserve proof, production authority.

Follow-on on branch: `/find` shared-store fail-closed before Autodev (`paid-dispatch-guard`,
commit `494e771`) — was known-missing at PIN.

## STAGE1B — THIS bounded run (claim-lock + AbortSignal)

1. **Idempotency claim-lock (not completed-result cache only)**  
   Cross-instance atomic **claim before any work**; owner + **canonical mandate hash** bound;
   concurrent same-key → consistent result or explicit in-progress; different body → conflict;
   stuck in_progress after crash/ambiguous dispatch → do NOT re-execute as free.
   Credit-lock TTL ≠ durable receipt. No process-local Map for claims (Memory last-write ≠ Kv).
   Serverless + non-Upstash + Idempotency-Key → fail closed. Missing key → new run, not labeled idempotent.

2. **AbortSignal through real Autodev fetch**  
   Combine caller mid-flight signal + ownership timeout on real provider fetch;
   reservation stays consumed on ambiguous cancel. Contract: cancel **after** fetch started.

## STAGE2A — PIN 680b59a (independent review confirmed subset)

Confirmed: core directions / first-failure-continue / geo cache v2 / session v2 /
economics-unknown / actual memory-backend block; 280 tests / tsc / build.
**Not** claimed: the three REAL integration bugs in Stage2A-followon.

## STAGE2A-FOLLOWON — queued AFTER Stage1B (do not interrupt Stage1B)

1. **All Autodev failures ≠ empty market** (`find-match` ~364–369)  
   All calls throwing → 200 `emptyReason: empty_inventory` `partialFailure: true` (same for
   all-`demo_limit`). Hard failure only `listings_unconfigured` (~339–358).  
   Must **never** tell "no cars / confirmed empty market" on zero successful provider responses.
   Failure / unavailable / quota vs genuine provider-empty need distinct HTTP / model / UI &
   English next step.  
   Handler+stub tests: all-timeout, all-quota, mix success(empty)/failure, all-success-empty,
   partial nonempty. No misleading headline even if per-query fields are correct.

2. **assembleRadar ~708–725 does NOT pass `deps.autodev.reserve` into `autodevSearch`**  
   After shared Upstash present, actual `/find` path still uses in-memory `runtimeDeps` counter;
   `reserveTotalCall` NOT called. Backend boolean block ≠ real ledger integration.  
   Wire true persistent shared reserve to actual dispatch throughout find/provider stack;
   full route+fetch-spy test must prove persistent key increments **before** fetch; parallel
   independent route instances share cap. Cannot pass by checking kv exists with unwired counter.
   production `main` unchanged until merge (known no-action yet). Exact conditional cache-hit /
   no-charge. Missing-backend 503 copy (~157–168) falsely says Auto.dev key missing — truthful
   reason, not a key request.

3. **`searchedModels` = planned list includes `budget_exhausted` entries** (`find-match` ~327;
   UI "Live models checked" `AssistantFlow` ~921)  
   Must separate planned / attempted / succeeded / skipped; budget-skipped never claimed checked.
   Closed make list additionally appends Toyota Camry editorial 4th URL after 3 named models —
   clarify strict explicit model scope vs suggested extras so limited budget is not consumed
   without mandate. Mandate-selected models prioritized; no fake "checked".

## STAGE2B — queued (NOT this turn; after 2A-followon)

- Gov unsupported / `inventory.search` no-op cached-as-success
- `replace` only relabels — real next-candidate load + planner feedback
- Missing planner-context tool bodies/steps for dynamic replan
- Typed next-action execution feedback  
User purpose remains **actual autonomous investigation**, not static report.

## STAGE3 — queued (NOT this turn)

Eval tautologies (`claimsSafeBuy` always 0, `insufficientEvidenceInvestigated`,
`realSourceAvailable` const, `rejectReplaceCovered`, mock≠efficacy).

## Ops note (read-only; no permission change)

Console authenticated (Yuri/MoonDancer); ~$24.16 visible — **no** max-cost/reserve control
verified. **NO paid-calls permission change.** No fake env grant. Main writer does not touch
console keys/settings.

## Retained (do not regress)

- Real `scout_plan` HTTP markers/schema (not `Agent.process()`)
- Client budget/spend strip; SDK feature-off + task auth
- Stage1 durable quota / non-bypass paid scout
- Consumer English; Orbitron / branding — no nav/design redo
