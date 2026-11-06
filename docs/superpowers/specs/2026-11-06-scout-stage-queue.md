# Scout review stages — queue (do not silently drop)

writtenAt_utc: 2026-11-06
owner_mandate: Stage1 NOW only. Stage2+3 queued for subsequent turns.
constraints: no spend / secrets / deploy / merge / Graph / model change. No self-release approval.

## STAGE1 — safety / invariants (this turn) — DONE on branch

Quota durability, paid-path non-bypass, zero-budget zero-dispatch, backend identity,
pre-dispatch accounting, conservative timeout/abort handling. Acceptance covered by
`src/io/kv.upstash-semantics.test.ts`, `src/io/persistent-quota.test.ts`,
`src/server/scout/paid-execution.test.ts`, `src/server/scout/providers.zero-budget.test.ts`.

**No "$5 guarantee" claim while paid live path is deliberately non-bypassably blocked.**

### /find vs Stage1 (exact)

- **origin/main** still uses legacy GET/SET JSON blob quota (`persistent-quota` bump race) and
  Upstash `setNx` always `SET NX PX 4000`. Main does **not** have Stage1 durable seed /
  corrupt fail-closed / backend identity paid gates.
- **This branch** rewrites shared `src/io/kv.ts` + `src/io/persistent-quota.ts` (also used by
  `/find` via `reserveTotalCall(getKv())` in `deps`). When/if merged, `/find` inherits durable
  counter + NaN fail-closed + durable SET NX. It does **not** yet get Stage2 `/find` product
  fixes (first-error abort, third-model, nationwide comps ZIP, AssistantFlow sample restore).
- Vercel without Upstash still yields MemoryKv — `/find` can still spend without a shared store
  guard beyond monthly INCR on whatever backend `getKv()` returns; Stage1 does not add a new
  `/find`-only shared-store gate (queued if required as follow-on).

## STAGE2 — queued (NOT this turn)

Do not "fix" by blanket-forbidding all cars or stripping autonomy to a decorator.
Need real typed next-action execution feedback and replanning; unknown ≠ pass but
legitimate investigate still allowed.

Tracked findings (still open):

1. `/find` first-error abort (approx. assemble 100–112) / third-model (70–74) /
   nationwide comps ZIP (138) — unchanged relative to Stage1.
2. Session restore `source:sample` → `sample:false` in AssistantFlow (~208) — unchanged.
3. Flip-rank repair 600 + title 350; `assumption:null` asking-median — unchanged.
4. Unknown history still emits `data_sufficiency` pass (~gates 138) — must not equate
   unknown with safety pass while still allowing investigate.
5. `personal_fit` labeled verified (~runner 546) — honesty fix needed.
6. Gov unsupported step cached as success — must not look like successful evidence fetch.
7. `inventory.search` no-op cached success — same.
8. `replace` only relabels; does not load next candidate — needs real replacement pull
   via subsequent select + planner feedback (not silent auto-fill of “any next VIN”).
9. Missing planner-context tool bodies/steps for replan — typed execution feedback required.

## STAGE3 — queued (NOT this turn)

Eval harness tautologies still open:

- `claimsSafeBuy` literal false → always 0
- `insufficientEvidenceInvestigated` only increments when `claimsSafeBuy` true → always 0
- `realSourceAvailable` constant true
- `rejectReplaceCovered` accepts any completed
- All 3 cases mock-script control plumbing, not efficacy; same ~3 investigate /
  0 reject / 1 relabeled replacement — no useful quality measurement

Required later: non-tautological labels, outcome quality, tool-sequence + real
replacement tests, honest baseline path; offline dynamic planner contract without
hosted SERV efficacy claims.

## Retained good fixes (do not regress)

- Real `scout_plan` HTTP markers/schema (not prompt theater / not `Agent.process()`)
- Client budget/spend strip
- SDK feature-off + task auth binding
- Fixture GET metadata + non-200 scout statuses
- Multi-target preferred makes (once Stage1 zero-budget / paid gates hold)
