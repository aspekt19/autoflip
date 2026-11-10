# SERV decision-path audit (Find / Resale / Deal Radar)

Generated with the `cursor/serv-decision-trail-9807` work. Line numbers refer to that branch tip.

Eval harness (no paid calls by default): `scripts/eval-serv-vs-baseline.ts --dry-run` → `eval/results/serv-vs-baseline-latest.json`.

## Summary table

| Surface | SERV step | File:lines | Changes finalAction / pick / checks? | Notes |
|---------|-----------|------------|--------------------------------------|-------|
| Find need parse | `need_guard` / `need_extract` | `src/server` need path → `proofRecords` on `/api/need` | Criteria / need fields (clamped) | UI: `DecisionRecordList` in `AssistantFlow.tsx` |
| Find next-check | `find_next_check` | `src/server/find-next-check-live.ts` (~105–360) | **Yes — which check runs** (allowlist clamp) then `applyFindNextCheck` | Deterministic fallback when SERV unavailable (honest) |
| Find settle | `verdict_decide` + `verdict_challenge` | `src/server/find-settle-serv.ts` 169–287 → `runShopperVerdictServ` | **Yes — Buy/Negotiate/Pass** via `finalAction`; pick stays code ranking | Challenge disagreement applies under guardrails (`shopper-verdict-serv.ts` ~413–441) |
| Resale plan/pick/challenge | `resale_*` profiles | `src/server/resale-settle-serv.ts` | **Yes — VIN pick / challenge** among allowlisted VINs; money action via `applyFlipPublishedAction` | Journal: `ResaleDecisionJournalView` |
| Resale shopper | `verdict_decide` + challenge | `resale-settle-serv.ts` ~1621–1800 | **Yes — published `verdictAction`** when SERV returns allowlisted action | Now also emits `proofRecords` → UI `DecisionRecordList` |
| Radar re-check | `verdict_decide` (+ optional challenge) | `src/server/radar-serv.ts` `reviewPersonalCandidate` ~183–455 | **Yes — `alertWorthy`** (buy/negotiate alert; challenge can clear alert) | **Fixed:** no-key path no longer alerts on code price alone |
| Radar guard | `radar_guard` | `radar-cycle.ts` / assemble | Gate before review | `proofRecords` on Check/feed (owner-filtered) |

## Decorative / bypass fixes in this PR

1. **Radar no SERV key** (`radar-serv.ts`): previously `alertWorthy: true` with code price only — SERV bypassed. Now **does not alert** without a SERV decision when evidence exists; proof status `skipped_no_key`.
2. **Resale missing shared proof journal**: had Resale journal + `AgentDecisionTrail` but not `lemonless.decision_proof.v1` rows. Now threads `proofRecords` from shopper settle through job delivery into `DecisionRecordList` (purpose, response id, what changed, raw response).

## What still is code-owned (by design, with TS guardrails)

- **Which car is ranked first on Find**: `selectBestDealOnEvidence` — SERV reviews that pick; challenge can change the **verdict**, not invent a new VIN.
- **Dollar figures**: always TypeScript (P&L, fair value, comps).
- **Allowlists / clamps**: SERV choices outside allowlist are clamped or rejected; never invented response ids on failed/skipped rows.
