# t308 — Safe browser action cost map (owner supplement)

**Scope:** code + existing tests only. No implementation, no merge, no live Autodev/SERV/credit/provider calls, no SERV probe harness.

| Field | Value |
|---|---|
| Published main SHA | `06f8bad3d03402662fd821f8617aff3c5b51c891` (confirmed) |
| Tree | `ca6f9baad8ea3010d9a59a075a6e5f8294ca311d` (confirmed) |
| Tip | Merge PR #74 (`cursor/find-price-handoff-6237`) |
| Authoring mode | Detached HEAD at above SHA → branch `cursor/t308-credit-cost-map-d4d0` (artifact only) |
| Sister work | Broader t307 audit may write elsewhere — this file is the t308 deliverable |

**Legend (cost class):**
- **client-only** — browser navigation / local state; no server provider spend
- **Kv-only** — Upstash/local Kv read/write (credits ledger, findctx, comps cache, persist)
- **free gov** — NHTSA / fueleconomy.gov / Census geocoder (no Autodev/SERV bill)
- **paid Auto.dev** — `api.auto.dev` HTTP; consumes monthly `reserveTotalCall` quota (`ASSUMPTIONS.autodevMonthlyStop = 900`)
- **paid SERV** — `inference-api.openserv.ai` via `runServ` (needs `SERV_API_KEY`)
- **credit debit** — internal report credit via `creditSpend` (`src/io/credit-book.ts`)
- **KNOWN EXTERNAL PAID** — flags Autodev and/or SERV network when keys are configured

---

## 1. Safe action cost matrix (browser submits)

| Browser action | UI / route | Handler evidence | Cost classes | Notes |
|---|---|---|---|---|
| **Homepage task / Find search entry** | `HomeSearch` → `router.push(/find?…)` | `src/components/HomeSearch.tsx` (`homeFindEntryParams`); `src/components/HomeStage.tsx` | **client-only** | Comment in HomeSearch: “no paid search”. No `/api/*`. |
| **ZIP / radius continue (budget → understand)** | `/find` budget stage → `understand()` | `AssistantFlow.tsx` → `POST /api/need` → `understandNeed` (`src/server/understand-need.ts`, `src/app/api/need/route.ts`) | **paid SERV** (if key) · else form-only local parse | When `SERV_API_KEY` set: `need_guard` + `need_extract` (2 SERV). ZIP/radius attached here, not on hero. **No credit debit. No Autodev.** |
| **Follow-up answers (ZIP/use/repair/profit)** | `/find` follow stage | `answerFollowUps()` → repeated `POST /api/need` | **paid SERV** per call (same as above) if key | Still no Autodev / no credit. |
| **Find search submit (Show cars)** | `/find` confirm → `findCars()` | `POST /api/match` → `runFindMatch` (`src/app/api/match/route.ts`, `src/server/find-match.ts`) then `rememberFindAnalysisContexts` | **KNOWN EXTERNAL PAID: Auto.dev** (≤ `FIND_MAX_PROVIDER_QUERIES` = 6) · **Kv-only** (mint `findctx` tokens) | Each direction query → `assembleRadar` → `autodevSearch`. Cache hits skip reserve. **No SERV. No credit debit.** Rejects sample fixtures as live. |
| **Listing select / Full analysis — 1 credit** | Results card CTA | `analyze()` → `resolveSelectedListingHandoff` → `POST /api/report` (`AssistantFlow.tsx`, `src/domain/find-analysis-handoff.ts`, `src/app/api/report/route.ts`) | **credit debit (1)** · **KNOWN EXTERNAL PAID: Auto.dev** · **KNOWN EXTERNAL PAID: SERV** · **free gov** · **Kv-only** | Requires `findContextToken`. Verify context **before** balance/assemble/spend. Spend key `report:analysis:findctx:{userId}:{token}`. |
| **Manual Check — free preview** | `/check` → Price check | `previewCheck()` → `POST /api/check` → `previewListing` | **KNOWN EXTERNAL PAID: Auto.dev** · **free gov** (recalls) | Explicit: “Does not spend a credit and does not call the writing check” (`check/route.ts`). No SERV. |
| **Manual Check URL/VIN → full report** | `/check` → Full analysis | `checkListing()` → `POST /api/report` (surface `check`) | **credit debit (1)** · **KNOWN EXTERNAL PAID: Auto.dev** · **KNOWN EXTERNAL PAID: SERV** · **free gov** | Spend key still **`report:{uuid}`** (legacy). VIN-only requires ask/miles/ZIP before charge. No findContext claim/idempotency. |
| **Scout UI — capability / session** | `/scout` | `GET /api/scout`, `POST/DELETE /api/scout/session`, `GET /api/account` | **Kv-only** (session/grant/caps) | Read path; no Autodev/SERV. |
| **Scout run — default / offline** | ScoutPanel “Run scout” without live/SERV | `POST /api/scout` → `safe-execute` with `preferLive=false`, `planner=offline_heuristic` | **fixture/replay** · **free gov** tools possible · **Kv-only** | Contrasts ordinary Find: Scout defaults to checked-in fixture inventory, **not** Autodev search. OpenServ SDK adapter is **unmounted** (`src/server/openserv/scout-agent.ts` experimental). |
| **Scout run — live Autodev / SERV planner** | preferLive / planner=serv | Same POST; gated by `owner_grant` + `SCOUT_PAID_EXECUTION` + keys (`paid-execution.ts`, `spend-gate.ts`) | **KNOWN EXTERNAL PAID: Auto.dev** and/or **SERV** when authorized | Client attestation **rejected**. Unsigned `af_uid` cannot inherit owner spend. Env balance strings are diagnostics only. |
| **Credits UI — balance** | `/credits` | `GET /api/account` → `balanceOf` / `creditBalance` | **Kv-only** (read) | No spend. No Autodev/SERV. |
| **Credits UI — buy pack** | Buy button | `POST /api/credits/checkout` → Stripe Checkout | **Stripe** (test mode in UI copy) · **not** Autodev/SERV | Grants credits later via webhook (`stripe/webhook`). |
| **Credits UI — history** | — | **No credit-history UI/API** in tree | N/A | Ledger `events` exist in Kv (`credit-book.ts`) but are not exposed to the browser. |
| **Report history list** | `/reports` | `listUserReports(getKv(), id)` SSR | **Kv-only** | Copy: reopen without another credit. Compare = client nav to `/compare-cars`. |
| **Open / share / refresh reopen report** | `/report/{id}`, `GET /api/report/[id]` | `readPersistedReport` | **Kv-only** | No debit. Re-POST same VIN+mode with reusable report → `alreadySaved: true`, **0 debit** (`report/route.ts` lines 91–107). Find token retry → claim replay / alreadySaved. |
| **Sample report** | `/report/sample` | static/sample path | **client / local sample** | Homepage: “labeled sample, no credit”. |
| **Makes/models fields** | Find refine | `GET /api/vehicles/makes|models` | **client + local catalog** | Makes route: “does not call vPIC or the listings provider”. |

### Ordinary Find vs Scout / OpenServ (contrast)

| | Ordinary Find (`/find` → `/api/match`) | Scout (`/api/scout`) | OpenServ SDK |
|---|---|---|---|
| Inventory | Live Autodev searches (≤6 / request) | Default fixture replay; live only with owner_grant | Unmounted experimental adapter |
| LLM | Not on match; SERV on `/api/need` and full report | Offline heuristic default; SERV planner opt-in + grant | Would call Scout capability channel — **not** mounted in Next production server |
| Report credit | Full analysis debits 1 | Scout run does **not** use report-credit ledger | N/A |
| Trust | `findContextToken` for card→report | Signed scout session / Bearer `af_` + grant | Separate ownerId binding |

---

## 2. Credit / handoff / report P0–P1 findings (code + tests only)

PR #74 semantics are on this head. Status below is from **source + existing unit/route tests**, not live browser proof.

### P0 — fixed on this head (regression-tested offline)

| ID | Issue | Fix evidence | Test evidence |
|---|---|---|---|
| HOLD1 paste-URL / surface spoof | Client surface/cta/VDP heuristics could grant “trusted find”; URL-only CTA asked for paste | Server-minted `findContextToken` in `/api/match`; verify before spend (`find-analysis-context.ts`, `report/route.ts`) | `find-handoff.route.test.ts` (forged VDP, zip+miles, wrong owner, missing token) |
| HOLD2 fee-as-ask still charged | Fee/placeholder ask still debited | `decideReportCharge` → HTTP **422**, `charge: false`, 0 debit (`report-chargeability.ts`) | `fee refusal` cases in `find-handoff.route.test.ts`, `report-analysis-idempotency.route.test.ts` |
| HOLD3 double-spend (find) | Parallel first submits → distinct `report:{uuid}` debits | Claim NX + spend key `report:analysis:findctx:…` before assemble | Concurrent barrier tests in both idempotency test files |
| HOLD4 FREE_REPORT | `grant(refund:key)` left spend event → retry free | `creditCompensateSpend` clears spend event; persist-landed never compensates | `creditCompensateSpend` + persist-fail/complete-fail tests |
| HOLD5 FREE_ORPHAN | Stale 90s reclaim compensated without checking durable report | Reclaim removed; aged `in_progress` fail-closed | HOLD5 tests explicitly assert no refund / no free re-analysis |
| Forced re-entry of known facts (find) | Trusted find demanded re-typed ask/miles | Trusted path overlays server ctx; skips `vinDetailGaps` | `report/route.ts` 149–165; handoff tests |
| 422 zero debit | — | Charge gate after assemble, before spend | Same fee-refusal tests |

### P1 / residual (still true on this head — do not call “pass” in prod)

| Severity | Finding | Evidence |
|---|---|---|
| **P1** | **Manual Check double-spend residual** — `/check` full report still uses `legacyReportUuidSpendKey(report.id)`. Parallel double-click can debit twice. | `report/route.ts` 334–337; PR74 body residual; OLD UUID tests document the class |
| **P1** | **Crash / stuck `in_progress` fail-closed** — winner dies after spend (or mid-flight) with no completed receipt → peers get `analysis_in_progress` (409); debit may stay charged; automatic reclaim deliberately absent to avoid FREE_ORPHAN. | `report-analysis-idempotency.ts` header; HOLD5 route tests; PR74 semantics |
| **P1** | **Report unavailable after charge (orphan window)** — if spend succeeded but persist never landed and compensate fails / process dies before compensate: debit kept, no report. Persist-landed + complete-fail path recovers (returns saved). | `report/route.ts` 358–380; complete-throw test keeps debit + replay |
| **P1** | **Fence TOCTOU** — release/complete are get-then-act, not true CAS on Upstash. | Comments in `report-analysis-idempotency.ts` |
| **P1** | **Intentional re-analysis charges again** — new Find ⇒ new token ⇒ may debit again (by design). | Route test “intentional re-analysis” |
| **P2** | **No credit history UI** — balance only; ledger events opaque to user. | `credits/page.tsx`, `account/route.ts` |
| **P2** | Shared demo account credits/reports visible across demo visitors. | credits + reports page copy |
| **Info** | Homepage/Find entry itself is free; Autodev spend begins at **Show cars** (`/api/match`), not at hero submit. | `HomeSearch.tsx`, `find-match.ts` |

### What was *not* claimed fixed live
- Exact Auto.dev field that emitted fee `$587` on the incident VIN (PR74 residual unknown).
- Cross-host Upstash CAS strength beyond existing Kv.
- Manual Check analysis-token idempotency (explicitly out of PR74 scope).

---

## 3. ONE authorized browser Find → Full analysis cycle — external invocations

Assumes production-like env with `AUTODEV_API_KEY` + `SERV_API_KEY` + distributed Kv; happy path; no cache hits; one card analyzed once.

| Step | Browser | External / paid | Internal |
|---|---|---|---|
| 1. Homepage “Find cars” | `/find?note=…` | **none** | client-only |
| 2. Budget + ZIP/radius continue | `POST /api/need` | **SERV ×2** (`need_guard`, `need_extract`) | — |
| 3. Optional follow-ups | `POST /api/need` ×N | **SERV ×2 per call** if model path runs | — |
| 4. Show cars | `POST /api/match` | **Auto.dev ×1–6** searches (`FIND_MAX_PROVIDER_QUERIES`) | Kv mint `findctx` per visible VIN |
| 5. Full analysis — 1 credit | `POST /api/report` | **Auto.dev** `listings/{vin}` + **Auto.dev** comps search if comps cache miss (0–1); **free gov** (vPIC, recalls, complaints, fuel, census×2); **SERV** up to **4** (`report_guard`, `verdict_decide` unless withheld, `check_rules`, `report_explain`) | Claim NX · **creditSpend −1** · persist report · Telegram if linked |

**Parent cost signal for parallel live browser run:** expect **Autodev quota burns on step 4 (dominant)** plus **1 subject + optional comps** on step 5; **SERV burns on need + report**; **exactly 1 internal credit** on successful deliverable report (0 if 422 fee refusal / invalid context / credits_required before spend).

Withheld ordered gates skip `verdict_decide` but still run guard/rules/explain when key present (`assemble.ts`).

---

## 4. Safe further-run guidance

| Safe without another internal credit | Spends another **internal** credit | Hits **paid providers** (Autodev / SERV) |
|---|---|---|
| Homepage → `/find` navigation | New successful Full analysis (new find token or manual Check) | `/api/need` (SERV) |
| Reopen `/report/{id}`, `/reports`, compare saved | Intentional re-Find → new token → Full analysis again | `/api/match` Show cars (Autodev ≤6) |
| Credits balance view (`GET /api/account`) | — | `/api/check` free preview (Autodev) |
| Scout GET caps / offline scout (no preferLive, no serv planner) | — | Full `/api/report` assemble (Autodev+SERV) even before debit on failures that assemble then 422 — **Autodev/SERV already spent; credit not** |
| Sample report | Stripe buy (money ≠ report credit until webhook grants) | Scout `preferLive` / `planner=serv` when owner_grant authorizes |

**Do not** (for cost-safe probing):
- Click Full analysis / Check full report repeatedly with new Find results.
- Enable Scout live inventory or SERV planner without owner authorization.
- Call SERV selftest / eval harnesses / probe scripts.
- Assume 422 fee refusal is “free” of Autodev — assemble already ran.

**Prefer for free observation:** homepage, ZIP UI without submitting need if avoiding SERV, report reopen, account balance, offline Scout, sample report, vehicles makes catalog.

---

## 5. Tested vs not tested (no false pass)

| Claim | Status |
|---|---|
| SHA + tree match published main | **Confirmed** this session |
| PR74 find-path idempotency / 422 / token trust / compensate / HOLD5 fail-closed | **Unit + route tests exist and encode expected semantics** (mocked Autodev/SERV/credits) |
| Manual Check UUID double-debit class | **Documented residual**; OLD tests prove the class still applies to UUID keys |
| Live browser Find→Full analysis on production/deploy | **Not tested by this agent** |
| Real Autodev / SERV / Stripe / credit ledger mutations | **Not executed** (forbidden) |
| Cross-instance Upstash race under real concurrency | **Simulated with shared MemoryKv in tests only** — not live Upstash proof |
| Exact fee-field RCA on live Auto.dev for incident VIN | **Unknown** (PR74 residual) |

**Verdict language for parent:** treat PR74 semantics as **code+test-backed on main**, not as **live-prod-passed**. Residual P1s (manual UUID double-spend; stuck `in_progress` after paid crash) remain open product/ops risks.

---

## Key file index

- Credits ledger: `src/io/credit-book.ts`
- Report charge + handoff: `src/app/api/report/route.ts`, `src/domain/report-chargeability.ts`, `src/domain/find-analysis-handoff.ts`, `src/server/find-analysis-context.ts`, `src/server/report-analysis-idempotency.ts`
- Find inventory: `src/server/find-match.ts`, `src/app/api/match/route.ts`, `src/io/autodev.ts`
- Need / SERV extract: `src/server/understand-need.ts`, `src/server/assemble.ts`, `src/server/serv/run.ts`
- Scout gates: `src/server/scout/paid-execution.ts`, `src/server/scout/spend-gate.ts`, `src/server/openserv/scout-agent.ts`
- UI: `src/components/HomeSearch.tsx`, `src/components/AssistantFlow.tsx`, `src/components/ScoutPanel.tsx`, `src/app/credits/page.tsx`, `src/components/ReportHistoryList.tsx`
- Tests: `src/app/api/report/find-handoff.route.test.ts`, `src/app/api/report/report-analysis-idempotency.route.test.ts`, `src/server/report-analysis-idempotency.test.ts`, `src/domain/report-chargeability.test.ts`
