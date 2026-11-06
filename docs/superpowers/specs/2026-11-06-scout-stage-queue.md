# Scout / Find review stages — queue (do not silently drop)

writtenAt_utc: 2026-11-06
constraints: no spend / secrets / deploy / merge / Graph / model change. No self-release approval.
Stage1 PIN `d8187b8` independently confirmed for listed items — **not full release / not $5 proof**.

## STAGE1 — PIN d8187b8 (independent review confirmed subset)

Confirmed: durable monthly seed, non-numeric reject, env balance cannot grant, 0-budget 0-fetch,
cache monthly refund, per-make ceiling, HTTP/SDK no injected grant.
**Not** claimed: full release, $5 reserve proof, production authority.

Follow-on on branch: `/find` shared-store fail-closed before Autodev (`paid-dispatch-guard`,
commit `494e771`) — was known-missing at PIN.

## STAGE1B — queued NEXT bounded run (do not implement inside Stage2A)

1. **Idempotency claim-lock (not completed-result cache only)**  
   Today: completed-result cache; overlapping same-owner/same-key both run; memory last-write vs
   Kv setNx first-wins → divergent cross-instance results. Key not bound to mandate body.  
   Need: cross-instance atomic **claim before any work**; owner + **canonical mandate hash** bound;
   concurrent same-key → consistent result or explicit in-progress; different body → conflict;
   no unsafe re-execution after lease expiry / ambiguous upstream dispatch.  
   Credit-lock TTL ≠ durable receipt. Conservative charges; **no paid tests**.  
   Tests: actual overlapping API callbacks across **isolated service instances** (not sequential
   cache-only).

2. **AbortSignal through real Autodev fetch**  
   Today: route/provider pre-abort only; `autodev.ts` uses own 12s timeout and ignores parent
   mid-flight cancel.  
   Need: combine timeout + caller signal on real provider fetch; reservation stays consumed if
   unknown-billed. Contract test: cancel **after** fetch started → mock fetch `signal.aborted`
   (not only pre-set abort or argument spy).

Rules: no production authority via env strings; `testAuthority` numeric stub only in isolated
injection — never assert `verified_account_source` ≡ genuine balance. Production HTTP+SDK stay
hardcoded none.

## STAGE2A — THIS turn (search + provenance + economics)

1. `/find` multi-make/model within server-owned provider budget; first-direction error does not
   abort remaining queries; unsupported/empty/error differentiated; fetch-spy tests (≥3 directions,
   first timeout then success, multi-make / optional ZIP / nationwide).
2. Comp cache: actual geographic scope in key + payload; nationwide ≠ local ZIP comps; VIN report
   respects geo confidence; schema migration no leak of old miskeyed rows.
3. AssistantFlow `af-flow`: never force `sample:true` → `sample:false`; version migration;
   restore fixture+live+unknown without phantom live.
4. Economics/evidence: repair/title unknown → explicit assumptions; asking median labeled ≠ sold;
   unknown history `data_sufficiency` ≠ PASS; `personal_fit` not `verified`; investigate-unknown
   preserved; seller claims remain seller_claim.
5. `/find` shared-store gate on serverless (actual Kv backend).

## STAGE2B — queued (NOT this turn)

- Gov unsupported / `inventory.search` no-op cached-as-success
- `replace` only relabels — real next-candidate load + planner feedback
- Missing planner-context tool bodies/steps for dynamic replan
- Typed next-action execution feedback  
User purpose remains **actual autonomous investigation**, not static report — next stage after 2A.

## STAGE3 — queued (NOT this turn)

Eval tautologies (`claimsSafeBuy` always 0, `insufficientEvidenceInvestigated`, 
`realSourceAvailable` const, `rejectReplaceCovered`, mock≠efficacy).

## Retained (do not regress)

- Real `scout_plan` HTTP markers/schema (not `Agent.process()`)
- Client budget/spend strip; SDK feature-off + task auth
- Stage1 durable quota / non-bypass paid scout
- Consumer English; Orbitron / branding — no nav/design redo
