# SERV decision-path audit (Find / Resale / Deal Radar)

Generated with the `cursor/serv-decision-trail-9807` work (detail pass from [Audit SERV decision paths](bc-8d234b00-c7ba-5de0-89de-a01357c6ba37)). Line numbers drift; prefer symbols below.

Eval harness (no paid calls by default): `scripts/eval-serv-vs-baseline.ts --dry-run` → `eval/results/serv-vs-baseline-latest.json`.

## Summary table

| Surface | SERV step | Call site | Changes finalAction / pick / checks? | Notes |
|---------|-----------|-----------|--------------------------------------|-------|
| Find need parse | `need_guard` / `need_extract` | `understandNeed` | Criteria / need fields (clamped) | UI: `DecisionRecordList` in `AssistantFlow.tsx`. Resale `/api/need` also calls this but drops `proofRecords` in UI |
| Find next-check | `find_next_check` | `runFindNextCheckLive` → orchestrator | **Yes — which check runs** (allowlist clamp) | Deterministic fallback when SERV unavailable. UI filters for `find_next_check` proofs but live path does not yet emit `DecisionProofRecord` for that purpose. Free-gov open can override executed check away from SERV choice |
| Find settle | `verdict_decide` + `verdict_challenge` | `runFindSettleServ` → `runShopperVerdictServ` | **Yes — Buy/Negotiate/Pass** via `finalAction`; **pick stays code ranking** | Challenge disagreement applies under guardrails |
| Resale plan/pick/challenge | `resale_*` | `runResaleSettleServ` | **Yes — VIN pick / challenge** among allowlisted VINs | Journal: `ResaleDecisionJournalView` |
| Resale shopper | `verdict_decide` + challenge | `runResaleSettleServ` → `runShopperVerdictServ` | **Yes — published `verdictAction`** | Emits `proofRecords` → UI `DecisionRecordList` |
| Resale evaluate (one-car) | — | `evaluateResaleDeal` | **No SERV** | Code comps only; no decision journal by design |
| Radar re-check (personal) | `verdict_decide` (+ optional challenge) | `reviewPersonalCandidate` via `runRadarCycle` | **Yes — `alertWorthy`** | Challenge can only veto alert. **Fixed:** cycle always calls `reviewPersonalCandidate` (no inline `alertWorthy: true`) |
| Radar flip re-check | `flip_feasibility` / `radar_review` | `judgeFlipAlerts` + `flipCandidateOutcome` | **Yes — alert vs skip vs not_reviewed** | **Fixed:** no SERV key → `serv_skipped`, not `code_alert` |
| Radar guard | `radar_guard` | `runRadarCycle` / assemble | Soft gate / proof | Always one row when assembled |

## Decorative / bypass fixes in this PR

1. **Radar no SERV key — personal** (`radar-serv.ts` + `radar-cycle.ts`): previously the cycle short-circuited with `alertWorthy: true` / “code price rating only” and never hit `reviewPersonalCandidate`. Now the cycle always calls review; missing key → skip + `skipped_no_key` proof (no alert).
2. **Radar no SERV key — flip** (`flipCandidateOutcome`): previously `code_alert`. Now `serv_skipped` with the same honesty sentence.
3. **Resale missing shared proof journal**: threads `proofRecords` from shopper settle through job delivery into `DecisionRecordList`.

## Still open / by design (not in this PR)

- Find next-check does not emit `DecisionProofRecord` (UI filter is aspirational).
- Orchestrator may override SERV’s chosen check while free public checks remain.
- Resale evaluate path has no SERV and no decision journal.
- Resale free-text `/api/need` mutates form fields but does not render returned `proofRecords`.
- Find settle never replaces the ranked car — only the Buy/Negotiate/Pass action.

## What still is code-owned (with TS guardrails)

- **Which car is ranked first on Find**: `selectBestDealOnEvidence` — SERV reviews that pick; challenge can change the **verdict**, not invent a new VIN.
- **Dollar figures**: always TypeScript (P&L, fair value, comps).
- **Allowlists / clamps**: SERV choices outside allowlist are clamped or rejected; never invented response ids on failed/skipped rows.
