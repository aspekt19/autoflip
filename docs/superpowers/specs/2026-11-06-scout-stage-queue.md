# Scout / Find review stages — queue (do not silently drop)

writtenAt_utc: 2026-11-06
constraints: no spend / secrets / deploy / merge / Graph / model change. No self-release approval.
Stage1 PIN `d8187b8` under independent review — **do not claim Stage1 verified**.

## STAGE1 — safety / invariants — PIN d8187b8 (independent review)

Durable quota, non-bypass paid scout path, zero-budget zero-dispatch, backend identity.
**Not claimed verified by this agent.**

Follow-on (if touched for Stage2A `/find`): serverless paid Autodev dispatch must fail closed
without actual Upstash Kv backend — separate commit for traceability.

## STAGE2A — NOW (search + provenance + economics)

1. `/find` multi-make/model within server-owned provider budget; first-direction error must not
   abort remaining queries; unsupported/empty/error differentiated; fetch-spy tests (≥3 directions,
   first timeout then success, multi-make / optional ZIP / nationwide).
2. Comp cache: actual geographic scope in key + payload; nationwide ≠ local ZIP comps; VIN report
   respects geo confidence; schema migration no leak of old miskeyed rows.
3. AssistantFlow `af-flow`: never force `sample:true` → `sample:false`; version migration;
   restore fixture+live+unknown without phantom live.
4. Economics/evidence: repair/title unknown → explicit assumptions (not `assumption:null`);
   asking median labeled ≠ sold; unknown history `data_sufficiency` ≠ PASS; `personal_fit` not
   `verified`; preserve investigate-unknown; seller claims remain seller_claim.

## STAGE2B — queued (NOT this turn)

Do not "fix" by blanket-forbidding all cars or stripping autonomy to a decorator.

- Gov unsupported / `inventory.search` no-op cached-as-success
- `replace` only relabels — needs real next-candidate load + planner feedback
- Missing planner-context tool bodies/steps for dynamic replan
- Typed next-action execution feedback

## STAGE3 — queued (NOT this turn)

Eval tautologies:

- `claimsSafeBuy` literal false → always 0
- `insufficientEvidenceInvestigated` only when `claimsSafeBuy` true → always 0
- `realSourceAvailable` constant true
- `rejectReplaceCovered` accepts any completed
- Mock-script control plumbing ≠ efficacy; need non-tautological quality/tool-sequence tests

## Retained (do not regress)

- Real `scout_plan` HTTP markers/schema (not `Agent.process()`)
- Client budget/spend strip; SDK feature-off + task auth
- Fixture GET metadata; Stage1 durable quota / non-bypass paid scout
- Consumer English; existing Orbitron / branding — no nav/design redo
