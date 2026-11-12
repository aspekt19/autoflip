# SERV boundary audit — Check (single-listing)

**Scope:** `/check` UI (`CheckFlow`), `POST /api/check`, `POST /api/v1/check`, MCP `check_car`, Check delivery/cache, `runCheck` listing/VIN/paste paths, shared shopper SERV (`runShopperVerdictServ` / gates / clamp), free-check quota settlement, and report/free-check surfaces that reuse the same shopper verdict path for a Check-shaped delivery.

**Branch:** `cursor/serv-boundary-structural-3e9b`  
**Method:** Grep + read of Check surfaces. Line numbers are approximate; prefer symbols if they drift.

**Goal architecture (reminder):**
- Verdict made by SERV (OpenServ, all features: multipath, Prompt Guard, Shadow) from information actually in the link/VIN data.
- Code only: fetch page/VIN data server-side, pass to SERV **UNFILTERED** (no code-made scores, flags, or verdict shortcuts), validate SERV’s answer against fetched facts, exact math, journal SERV response ids.
- Charge only on a delivered verdict; refund / never settle otherwise.

**Fate key:**
- `removed` — **target** disposition (SERV owns it, or honesty fail / repair). Not verified gone unless the main audit Verified table says so.
- `still present` — verified still reachable in production code (honest status).
- `moved into SERV` — keep capability as SERV input/tool evidence or SERV-owned param, not a silent code decision.
- `kept as guardrail` — post-SERV validation / money math / auth / infra / fetch hygiene; justification required.

---

## Product rules (verify)

| # | Rule | Status | Evidence | Fate |
|---|------|--------|----------|------|
| 1 | Everything requires login | **Kept (correct)** | `requireVerifiedAccountForChecks` on `/api/check`; CheckFlow redirects unauthenticated callers to `/login`; v1/MCP require Bearer `af_…` with `check` scope | **kept as guardrail** — auth/identity, not ranking |
| 2 | 3 free searches, then credits only | **Kept (correct)** | `ASSUMPTIONS.freeVehicleChecksPerMonth = 3`; `/api/check` + `runAgentCheck` reserve free slot first, then `spendCredit` / `spendReportCredit` | **kept as guardrail** — billing allotment |
| 3 | Charge only on a delivered verdict; refund otherwise | **Mostly kept; nuance** | Fail/blocked/`!result.ok` never settle; `releaseFreeCheck` on throw; credit spend after success. **Gap:** `result.ok` with code screening + `no_serv_step` (gates withheld / no key) still settles free/credit as a “delivered” Check | Charge-on-success **kept as guardrail** for infra; settling when only a **code** screening headline exists is a product-boundary defect vs SERV-owned verdict — see settlement bullets |

---

## Explicit callout — code that influences the Check verdict

These paths create or reshape the published Check `verdict` / `verdictLabel` / buy-negotiate-pass action (not mere display copy):

1. **`verdictFromBadge`** (`run-check.ts`) — maps price badge tone + stop/sold flags → `good_deal` / `fair` / `overpriced` / `walk_away` / `insufficient_data` **before** SERV.
2. **`evaluateListingPrice` / `priceBadge`** — code math produces `priceVerdict` / tone that feeds (1).
3. **`listingRedFlags` + park-it / park-outside / VIN-mismatch injects** — code stop flags force `walk_away` via (1) and feed ordered gates that withhold or forbid SERV actions.
4. **`checkConfidence` / VIN dossier confidence ladders** — code scores High/Medium/Low used as `screeningConfidence` (caps SERV trail) and as published headline when SERV does not finish.
5. **`buildCheckComputedReport` + `verdictDecisionFacts.codeBaselineAction`** — code screening verdict is embedded into SERV’s decide payload as baseline / gate inputs (not unfiltered raw page/VIN facts alone).
6. **`runOrderedGates` / `clampDecision` / `resolveVerdictDecision`** — code can withhold SERV entirely, forbid buy/negotiate, force pass, or fall back to deterministic code action when SERV fails/malforms.
7. **`headlineFromGuardedDecision`** — when `no_serv_step` / missing SERV action, **publishes the code screening verdict** as the Check headline.
8. **Post-SERV stop confidence clamp** in `attachCheckShopperServ` — code rewrites agent confidence high→medium after SERV returns.
9. **Default VIN dossier label** `"VIN dossier (free sources)"` when unpriced — code default verdict kind `dossier` without a SERV buy/negotiate/pass call.

---

## 1. `/check` UI — `CheckFlow.tsx`

- `src/components/CheckFlow.tsx:291-293` — client redirects to `/credits` when free remaining is 0 and credits &lt; 1 — fate: **kept as guardrail** (UX mirror of server gate; server still enforces).
- `src/components/CheckFlow.tsx:319` — posts to `/api/check` only — fate: **kept as guardrail** (single Check entry).
- `src/components/CheckFlow.tsx:341-343` — on `credits_required`, routes to credits — fate: **kept as guardrail**.
- `src/components/CheckFlow.tsx:352` — on auth failure, routes to `/login?callbackUrl=/check` — fate: **kept as guardrail** (product rule 1).
- `src/components/CheckFlow.tsx:447` — copy: no login/captcha bypass on listing walls — fate: **kept as guardrail** (honesty; matches blocked-fetch refusal).

---

## 2. `POST /api/check` — auth, quota, settlement, cache

- `src/app/api/check/route.ts:106-107` — `requireVerifiedAccountForChecks()` before work — fate: **kept as guardrail** (login required).
- `src/app/api/check/route.ts:156-168` — up-front refuse when free slots &lt; 1 and balance &lt; 1 (no `runCheck`) — fate: **kept as guardrail** (billing gate; avoids unpaid fetch burn).
- `src/app/api/check/route.ts:174-208` — VIN month-cache short-circuit returns prior result without new free/credit spend — fate: **kept as guardrail** (idempotent delivery; not a new verdict invent).
- `src/app/api/check/route.ts:210-228` — stale/degraded cache → 409 offer fresh — fate: **kept as guardrail** (honesty vs replaying old stop-flag logic).
- `src/app/api/check/route.ts:246-263` — `!result.ok` returns without settle (`creditCharged: false`) — fate: **kept as guardrail** (product rule 3).
- `src/app/api/check/route.ts:291-343` — after `result.ok`, reserve free check then spend credit — fate: **kept as guardrail** for settle-after-success; **flag:** still settles when published headline is code screening only (`no_serv_step`) — treat SERV-less “ok” as non-deliverable or repair before charge (**removed** as chargeable verdict when SERV did not decide).
- `src/app/api/check/route.ts:351-360` — `checkResultIsCacheable` skips month cache when `no_serv_step` / recalls unavailable — fate: **kept as guardrail** (honesty).
- `src/app/api/check/route.ts:394-396` — catch path `releaseFreeCheck` — fate: **kept as guardrail** (refund/release).
- `src/server/check/check-delivery.ts:9` / `:15-40` — logic version + degraded replay refuse — fate: **kept as guardrail**.
- `src/domain/free-check-quota.ts:13` / `src/domain/assumptions.ts:73` — 3 free checks/month — fate: **kept as guardrail** (product rule 2).

---

## 3. Fetch / extract (pre-SERV data plane)

- `src/server/check/extract-listing.ts:56-58` — skips LLM extract when YMM already deterministic — fate: **kept as guardrail** (save SERV budget; not a verdict).
- `src/server/check/extract-listing.ts:61-72` — `check_guard` Prompt Guard before `listing_extract` — fate: **kept as guardrail** if treated as input hygiene; ensure it never invents a Check verdict (today it only blocks fill).
- `src/server/check/extract-listing.ts:75-91` — SERV `listing_extract` then `groundLlmFieldsInPage` — fate: **kept as guardrail** (grounding LLM to page text = fact hygiene, not ranking).
- `src/server/check/run-check.ts:162-184` — blocked fetch refusal, `creditCharged: false` — fate: **kept as guardrail**.
- `src/server/check/run-check.ts:187-` / `1490-1498` — Autodev VDP / URL-VIN fallbacks when wall/thin page — fate: **kept as guardrail** as alternate **fetch** of listing facts; must not invent YMM/price absent from feed/URL.
- `src/server/check/run-check.ts:1429-1449` — `CHECK_SERV_CALL_BUDGET = 3` bounds SERV HTTP — fate: **kept as guardrail** (infra budget) with honesty when decide/challenge skipped.
- `src/server/check/run-check.ts:253-337` (`searchComps`) — code chooses ±generation year window, 500 mi then nationwide, limit 24 — fate: **moved into SERV** as evidence-gathering tool params (today code silently widens pool that drives price verdict); infra max limit may remain as soft payload bound.

---

## 4. Code screening brain (primary verdict ownership leak)

- `src/domain/price-evaluation.ts:108-111` — `verdictFromPriceGap` → good/fair/high tone — fate: **removed** as Check **verdict** owner; fair-value **math** may stay as exact numbers passed to SERV (**moved into SERV** as evidence fields only).
- `src/domain/price-badge.ts:52+` — wraps evaluation into badge for UI/report — fate: **moved into SERV** for decision use; display badge OK only if non-authoritative after SERV owns action.
- `src/server/check/run-check.ts` (`verdictFromBadge`) — sold/stop → `walk_away`; badge tone → `good_deal`/`fair`/`overpriced`; else `insufficient_data` — fate: **still present** (core code verdict shortcut; target: remove).
- `src/domain/listing/red-flags.ts:15+` — phrase/schema scans produce stop/caution flags — fate: **moved into SERV** as raw listing text + structured extract evidence; code must not map flags → final action. Post-SERV validate that cited flags exist in fetched text (**kept as guardrail** for citation grounding).
- `src/server/check/run-check.ts:740-791` / `1093-1111` — injects odometer, VIN mismatch, fuel conflict, park-it, park-outside stop flags — fate: **moved into SERV** as NHTSA/gov facts; stop→`walk_away` via `verdictFromBadge` **removed**.
- `src/domain/listing/confidence.ts:7-32` (`checkConfidence`) — weighted score → High/Medium/Low — fate: **removed** as published/screening confidence owner; evidence counts may be passed raw to SERV (**moved into SERV**).
- `src/server/check/run-check.ts:847` / `1233-1236` — `decided = verdictFromBadge(...)` or default `dossier` — fate: **removed** (code chooses screening verdict / default dossier label).
- `src/server/check/run-check.ts:871-880` / `1255-1265` — code caps confidence for stop / recalls unavailable — fate: **kept as guardrail** only as **post-SERV** honesty math against fetched NHTSA availability; pre-SERV screening cap that seeds SERV **removed**.
- `src/domain/build-check-agent-verdict.ts:39-170` — builds code-only trail + `no_serv_step` when SERV absent — fate: **kept as guardrail** for journaling “SERV did not run”; must not be sold as the agent choice (**removed** as substitute final verdict).
- `src/server/check/check-computed-report.ts:48-114` — packs code `verdict`, flags, fairValue, priceGap, reasons into `ComputedReport` for shopper SERV — fate: **removed** for embedding code `verdict` / score-like reasons as decision priors; **moved into SERV** as unfiltered subject + comps + gov records only; exact fairValue/priceGap math fields OK as numbers (**kept as guardrail** math).

---

## 5. Attach shopper SERV + headline (Check ↔ SERV boundary)

- `src/server/check/run-check.ts:421-422` — no `servKey` → return `codeTrail` as `agentVerdict` — fate: **removed** as publishable verdict path (honest fail / no charge); infra empty proof **kept**.
- `src/server/check/run-check.ts:425-428` — maps `dossier`/`insufficient_data` → report `insufficient_data` before SERV — fate: **removed** as pre-labeling SERV’s report verdict field.
- `src/server/check/run-check.ts:450-458` — `runShopperVerdictServ` with `screeningConfidence: codeTrail.confidence` — fate: **removed** screening confidence prior; pass evidence only.
- `src/server/check/run-check.ts:460-477` — gates withheld → `emptyAgentVerdict` + `no_serv_step` (no decide call) — fate: **removed** as silent skip of SERV; thin evidence should be SERV’s call or honest withhold **after** SERV sees raw facts (code withhold-before-spend is a verdict shortcut).
- `src/server/check/run-check.ts:480-510` — post-SERV stop flag forces confidence high→medium + synthetic serv_step — fate: **kept as guardrail** (honesty vs NHTSA stop facts) **or** repair challenge to SERV; rewriting confidence without response id is code influence — prefer journal as validation.
- `src/server/check/run-check.ts` (`headlineFromGuardedDecision`) — SERV action maps headline; **else publishes `screeningVerdict`** — fate: SERV mapping **kept as guardrail** (action∈allowlist + math); fallback to code screening **still present** (target: remove).
- `src/server/check/run-check.ts:590-603` (`checkResultIsCacheable`) — refuses cache on `no_serv_step` / recalls down — fate: **kept as guardrail**.

---

## 6. Shared shopper SERV / gates / clamp / facts (used by Check)

- `src/domain/verdict-decide.ts:47-131` (`verdictDecisionFacts`) — sends subject slice + fairValue/priceGap + **flagSummaries** + **gates** + **codeBaselineAction** + **allowedActions** — fate: `codeBaselineAction` / gate forbid lists as decision priors **removed**; raw fetched facts + exact math **moved into SERV**; `allowedActions` pre-constraint **removed** (validate after); journal ids **kept**.
- `src/domain/verdict-gates.ts:105-152` (`gateDataSufficiency`) — withholds buy/negotiate/pass when no ask/miles/&lt;minComps/history+recalls gap — fate: **removed** as pre-SERV verdict owner; may become **kept as guardrail** only if reframed as “do not charge / do not publish” without inventing `walk_away`/`good_deal`.
- `src/domain/verdict-gates.ts:155-165` — VIN identity withhold — fate: **kept as guardrail** (identity fact conflict) if it blocks publish+charge; must not substitute a code buy/pass.
- `src/domain/verdict-gates.ts:167-199` (`gateSafety`) — title brand / park-it / park-outside / odometer **forbid** buy/negotiate — fate: **moved into SERV** as evidence; hard money/safety clamp after SERV **kept as guardrail** only with repair-or-fail (today silent clamp/forcePass).
- `src/domain/verdict-gates.ts:202-219` (`gatePrice`) — priceGap / price-anomaly forbid buy — fate: **removed** as code price verdict rail; gap number **kept** as math evidence.
- `src/domain/verdict-gates.ts:222-268` (`gateMandate`) — budget/accident forbids (personal Check usually empty mandate) — fate: **kept as guardrail** when mandate user-tagged; accident-null forbid buy **moved into SERV** / post-validate.
- `src/domain/verdict-guardrails.ts:128+` (`clampDecision`) — overrides SERV choice to forced/forbidden set — fate: **kept as guardrail** for hard safety/money with mandatory repair-to-SERV or labeled override; silent rewrite without challenge **removed**.
- `src/domain/verdict-decide.ts:184-245` — no key / SERV fail / bad JSON → **deterministic_fallback** to code `actionFromVerdict(report.verdict)` — fate: **removed** (must not publish code baseline as SERV decision).
- `src/domain/verdict-decide.ts:248-265` — parse SERV + clamp — fate: parse/validate **kept as guardrail**; clamp per above.
- `src/server/shopper-verdict-serv.ts:186-213` — preview gates; skip decide when withheld — fate: **removed** relative to “SERV always sees unfiltered facts” (or keep only as no-charge withhold without code screening headline).
- `src/server/shopper-verdict-serv.ts:237-271` — null-content refusal retry once — fate: **kept as guardrail** (transport honesty).
- `src/server/shopper-verdict-serv.ts:328-329` — challengeConfidence high iff SERV unclamped else medium — fate: **moved into SERV** / challenge; code-assigned challenge confidence prior **removed**.
- `src/server/shopper-verdict-serv.ts:464-492` — challenge disagree may become final under clamp — fate: **kept as guardrail** if SERV challenge owns revision; clamp overrides **kept** with justification (safety) or repair.
- `src/server/shopper-verdict-serv.ts:511-587` — journals decide proof + `responseId` — fate: **kept as guardrail** (required journaling).
- `src/server/shopper-verdict-serv.ts:713-722` — `moreConservativeConfidence(screeningConfidence, …)` — fate: **removed** screening prior; post-hoc honesty vs facts **kept**.
- `src/server/shopper-verdict-serv.ts:745-767` — SERV fail clears verdict (no tidy fallback) on agentVerdict — fate: **kept as guardrail**; Ensure Check headline does not reintroduce screening via `headlineFromGuardedDecision` (today it can — see §5).

---

## 7. VIN dossier / listing orchestration specifics

- `src/server/check/run-check.ts:1000-1014` — invalid / undecodable VIN → 4xx, no charge — fate: **kept as guardrail**.
- `src/server/check/run-check.ts:1233-1236` — unpriced VIN → `{ verdict: "dossier" }` without SERV decide — fate: **removed** as default verdict; either SERV explains “no ask” or deliver non-verdict dossier with **no charge** (**kept** as free evidence pack only if product allows).
- `src/server/check/run-check.ts:1319-1341` — still calls `attachCheckShopperServ` (gates usually withhold without ask) — fate: attach OK; withhold+code dossier headline **removed**.
- `src/domain/purchase-readiness.ts` / walk-away USD from comps — fate: **kept as guardrail** as exact offer math for display; must not set Check action alone.
- `src/domain/questions.ts` (`dealerQuestions`) — seller question list — fate: **kept as guardrail** (UX checklist; not action enum).

---

## 8. Agent `/api/v1/check` + MCP `check_car`

- `src/app/api/v1/check/route.ts:18-19` — Bearer auth + `check` scope — fate: **kept as guardrail** (login/key equivalent).
- `src/server/agent-check.ts:156-162` — gate free/credits before `runCheck` — fate: **kept as guardrail**.
- `src/server/agent-check.ts:165-188` — `!result.ok` → no debit — fate: **kept as guardrail**.
- `src/server/agent-check.ts:197-231` — settle free then credit after success — fate: **kept as guardrail** with same SERV-less charge nuance as web.
- `src/server/agent-check.ts:234-280` — wraps same `runCheck` result + `proofRecords` — fate: **kept as guardrail** (same boundary defects inherited from `runCheck`).
- `src/app/api/mcp/route.ts:145-160` — MCP `check_car` → `runAgentCheck` — fate: **kept as guardrail** (thin RPC); no separate verdict brain.
- `src/server/mcp.ts:11-24` — tool description claims SERV plan/decide/second-check — fate: **kept as guardrail** for docs accuracy once boundary fixed; today overstates when gates withhold.

---

## 9. Report / free-check / shopper-verdict reuse

- `src/app/api/report/route.ts:97` — `requireVerifiedAccountForChecks` — fate: **kept as guardrail**.
- `src/app/api/report/route.ts:190-200+` — free-check reserve for non-Find report path — fate: **kept as guardrail** (same 3/month pool).
- `src/app/api/report/route.ts:365-378` — `decideReportCharge` refuses charge without ask/miles — fate: **kept as guardrail** (product rule 3 for full report).
- `src/domain/report-chargeability.ts:30-64` — charge only when ask+miles present — fate: **kept as guardrail**.
- `src/server/assemble` → `runShopperVerdictServ` — fate: **kept as guardrail** as shared shopper path entry (inherits §6 removed/moved defects; full report is adjacent, not a separate Check brain).

---

## Counts

| Fate | Count |
|------|------:|
| **Found** (decision / boundary points listed) | **75** |
| **removed** (primary fate) | **17** |
| **moved into SERV** (primary fate) | **6** |
| **kept as guardrail** (primary fate) | **52** |

Primary fate = first bold fate tag after `fate:` on each bullet; product-rule table rows counted once each (all three **kept**). Dual-tagged bullets use the first proposed structural fate. `still present` primary → removed. Enforced by `scripts/serv-boundary-audit-counts.test.ts`.

### Highest-leverage Check gaps vs target architecture

1. **Code screening owns the action enum** (`verdictFromBadge` ← price tone + stop flags) before SERV; SERV is optional overlay.
2. **Ordered gates withhold decide** so SERV never sees the case; UI still publishes code screening / dossier and may **charge**.
3. **`verdictDecisionFacts` ships `codeBaselineAction` + forbid lists** — not unfiltered link/VIN data.
4. **`headlineFromGuardedDecision` falls back to code screening** when SERV fails/withheld — reintroduces code verdict after shopper path clears `agentVerdict.verdict`.
5. **Settlement treats any `result.ok` as deliverable**, including SERV-less screening — conflicts with “verdict made by SERV” even while matching a broad “delivered payload” reading of rule 3.
