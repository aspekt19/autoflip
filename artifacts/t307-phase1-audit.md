# t307 phase 1 — fresh-user site audit (investigation ONLY)

**Date:** 2026-11-08  
**Scope:** Consumer journeys on published main after PR #74. No fixes. No live paid calls.  
**Agent:** cloud repo investigation + offline mocked/denied-network HTTP + unit/integration tests.

---

## 1. Identity proof

| Field | Value |
| --- | --- |
| Requested main SHA | `06f8bad3d03402662fd821f8617aff3c5b51c891` |
| Observed HEAD | `06f8bad3d03402662fd821f8617aff3c5b51c891` |
| Requested tree | `ca6f9baad8ea3010d9a59a075a6e5f8294ca311d` |
| Observed tree | `ca6f9baad8ea3010d9a59a075a6e5f8294ca311d` |
| Subject | `Merge pull request #74 from aspekt19/cursor/find-price-handoff-6237` |
| Checkout | detached HEAD at exact main (IDENTITY_OK) |

Audit evidence below was gathered against this OID+tree. Workspace briefly drifted to another branch mid-session; identity was restored before writing this file and re-confirmed.

---

## 2. Real prod vs demo surfaces

### Consumer production surfaces (primary nav / fresh user)

| Route | Role |
| --- | --- |
| `/` | Homepage hero + Find entry (`HomeStage` / `HomeSearch`) |
| `/find` | Free find flow → paid full analysis CTA |
| `/check` | Free price check → paid full report |
| `/radar` | Deal Radar scan / watches / alerts |
| `/reports` | Report history (browser `af_uid`) |
| `/favorites` | Saved cars |
| `/compare-cars` | Side-by-side of **owned** saved reports (Kv, 0 credit) |
| `/credits` | Stripe **test-mode** credit packs |
| `/pricing` | Pricing / Radar plans |
| `/report/[id]` | Persisted report view (public by id) |
| `/report/sample` | Labeled sample (no credit) |
| `/scout` | Scout UI — **off unless** `SCOUT_UI_ENABLED` |
| `/privacy`, `/terms`, `/developers` | Legal / agent docs |

### Demo / evaluation / non-fresh-user

| Surface | Evidence |
| --- | --- |
| `/demo?key=` | Sets `af_uid=demo-shared` when `DEMO_ACCESS_KEY` matches → redirects `/radar` (`src/app/demo/route.ts`) |
| Shared demo account | `DEMO_USER_ID`, daily credit reset; Reports/Favorites warn of shared visibility |
| `/compare` | Eval board reading `eval/results/latest.json` — **not** consumer car compare |
| `/activity` | Radar run activity log (operator-ish) |
| Credits UI copy | Explicit “Test checkout” / Stripe test cards (`src/app/credits/page.tsx`) |
| Scout | Default OFF (`SCOUT_ENABLED` / `SCOUT_UI_ENABLED` / `SCOUT_PAID_EXECUTION`) |
| Sample fixtures | Consumer `/find` **rejects** `source===sample`; sample report is labeled |

**Auth model:** unsigned browser cookie `af_uid` (`src/server/session.ts`). Not OAuth. Scout requires signed `af_scout_sid` or Bearer `af_` + owner grant — unsigned `af_uid` is not Scout auth.

---

## 3. Journey map + paid-vs-free matrix

**Legend**

- **User credit spend** = Lemonless report credit debit (`spendCredit`)
- **SERV** = OpenServ inference HTTP (`runServ` → `SERV_API_KEY`)
- **Autodev** = Auto.dev listings HTTP (`autodevSearch` / `autodevByVin` → `AUTODEV_API_KEY`)
- **Gov/free** = NHTSA / fueleconomy / Census (no product credit)
- **Kv-only** = Upstash/file ledger / history / favorites
- **Client-only** = no server provider call

| Browser submit / CTA | Handler | User credit | Autodev | SERV | Gov | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Home “Find cars” | `HomeSearch.submit` → `router.push(/find?…)` | no | no | no | no | Client nav only (`HomeSearch.tsx`) |
| Find: understand note / follow-ups | `POST /api/need` → `understandNeed` | no | no | **yes if key** (`need_guard`, `need_extract`) | no | Without key: form/heuristic parse (`understand-need.ts`) |
| Find: “Search listings” | `POST /api/match` → `runFindMatch` → `assembleRadar` | no | **yes** (≤6 queries) | **yes if key** (`radar_guard` per query) | no | Shared Kv gate on serverless; mints find context tokens |
| Find card “Full analysis” | `POST /api/report` (find handoff + token) | **1** after deliverable | **yes** (VIN + comps) | **yes if key** (guard/judge/explain) | **yes** | Charge gated by `decideReportCharge`; find token required |
| Find → credits resume | `af-pending-analysis` → same `/api/report` | **0 or 1** (idempotent) | maybe | maybe | maybe | Restored; analysis spend key dedupes |
| Check: “Check the price” | `POST /api/check` → `previewListing` | no | **yes** | no | **yes** (recalls) | Free badge only |
| Check: “Full analysis” | `POST /api/report` (manual) | **1** | **yes** | **yes if key** | **yes** | UUID spend key — **not** find-token idempotent |
| Check → credits return | writes `af-check` only | — | — | — | — | **No reader** → form empty after purchase |
| Watch from Find | `POST /api/radar/searches` | no | no | no | no | Kv + plan allowance; may invent radius (see findings) |
| Radar scan | `POST /api/radar` → `assembleRadar` | no | **yes** | **yes if key** | no | Same Autodev+SERV pattern as find |
| Radar “Full report / Analyze” | `POST /api/report` VIN-only | blocked / would charge | would | would | would | **Does not pass row price/miles** → `vin_needs_details` |
| Radar Check now | `POST /api/radar/check` → `runRadarCycle` | no | **yes** | **yes if key** | no | Plan/rate-limited; Autodev budget |
| Credits buy | `POST /api/credits/checkout` | Stripe $ | no | no | no | Test Stripe; grants via webhook |
| Plans checkout/portal | `/api/plans/*` | Stripe $ | no | no | no | Radar plans, not report credits |
| Account / header credits | `GET /api/account` | no | no | no | no | Kv balance |
| Reports / favorites / compare-cars | page + `/api/favorites` | no | no | no | no | Kv; compare uses owned ids only |
| Vehicles make/model pickers | `/api/vehicles/*` | no | no | no | models→vPIC | Makes curated |
| Scout start | `POST /api/scout` | Scout grant INCR (not report credit) | if preferLive+grant | if planner=serv | free-gov path | Default disabled; owner grant required for live |
| Sample report | `/report/sample` | no | no | no | no | Fixture |
| Demo entry | `GET /demo` | seeds demo credits | no | no | no | Key-gated |

### Exact file:function evidence (primary)

- Home → find: `src/components/HomeSearch.tsx` `submit`
- Need: `src/app/api/need/route.ts` → `src/server/understand-need.ts` `understandNeed` → `runServ`
- Match: `src/app/api/match/route.ts` → `src/server/find-match.ts` `runFindMatch` → `assembleRadar` (`src/server/assemble.ts`) → `autodevSearch` + `runServ("radar_guard")`
- Find analysis: `AssistantFlow.submitAnalysis` → `src/app/api/report/route.ts` `POST` → `assembleReport` + `spendCredit`
- Check preview: `src/app/api/check/route.ts` → `previewListing`
- Credits: `src/app/api/credits/checkout/route.ts` → Stripe
- Runtime keys: `src/server/deps.ts` `runtimeDeps` (`AUTODEV_API_KEY`, `SERV_API_KEY`)

**Safe for UI phase without paid calls:** homepage/nav, find form stages before match, empty/error states with keys unset, sample report, reports/favorites empty, scout-off page, credits page UI (do not click checkout), copy/radius controls.  
**Not safe without explicit auth:** any `/api/match`, `/api/check`, `/api/report` assemble, `/api/radar`, radar check-now, Scout preferLive/serv planner, Stripe checkout/webhook.

---

## 4. Prioritized findings (logic / data / journey — not style)

### P0 — broken primary CTAs / forced re-entry / known facts dropped

1. **Radar “Full report / Analyze / Confirm — 1 credit” omits price + miles (+ often ZIP)**  
   - **Evidence:** `src/app/radar/page.tsx` `openReport` posts `{ mode, vin, zip?, year? }` only. Rows/alerts already have `priceUsd` / miles.  
   - **Offline proof:** `POST /api/report` with VIN+zip → `vin_needs_details` missing `asking price, mileage` (`src/domain/vin-report.ts` + report route pre-assemble gate).  
   - **User impact:** CTA on cards that already show price/miles fails; user must leave Radar and re-enter facts on Check. Violates “never forced to re-enter known facts.”

2. **Check → credits path writes `af-check` but never restores it**  
   - **Evidence:** write-only `sessionStorage.setItem("af-check", …)` in `AssistantFlow.checkListing` (`~684`). Repo-wide: **no** `getItem("af-check")`. Find path correctly restores `af-pending-analysis`.  
   - **User impact:** after buying credits and returning to `/check`, URL/VIN/price/miles/ZIP are blank — full re-entry.

### P1 — reproducible inconsistencies / residual charge & geo bugs

3. **Silent radius invention when ZIP typed on confirm after Nationwide**  
   - **Evidence:** `AssistantFlow` confirm `onZipChange`: `distanceMiles: trimmed ? need.distanceMiles ?? 100 : null` (`~894`). Nationwide (`null`) + add ZIP → **100 mi invented**.  
   - Contradicts home/find “do not invent Nationwide params” and honest scope labeling.

4. **Find → Radar watch radius ignores shopper choice**  
   - Personal: `radiusMiles: need.distanceMiles ?? 100` — Nationwide+ZIP becomes 100.  
   - Flip: hardcodes `radiusMiles: 50` ignoring `need.distanceMiles` (`AssistantFlow.watch` ~514–524).  
   - API correctly rejects nationwide for watches (`radar/searches/route.ts`) but UI invents instead of asking.

5. **Manual `/check` full analysis still UUID spend-key — parallel double-debit residual**  
   - Documented in PR74 residual: find path uses analysis-token idempotency; manual path uses `report:{uuid}`. Double-click / concurrent submit can double-charge. Covered by tests as known class; not fixed for check.

6. **Radar credits redirect drops return + pending payload**  
   - `openReport` → `/credits?need=1` with **no** `return=` and no pending analysis storage (`radar/page.tsx` ~163). Even after fixing (1), resume would still lose context.

7. **Report “share” is raw public URL — no share UI; no owner gate on view**  
   - `/report/[id]` + `GET /api/report/[id]` serve any id (`readPersistedReport`). History/compare are owner-scoped; viewing is not. Fresh users get no copy/share control; anyone with id can open. Data exposure / missing share affordance — flag for product decision (not style).

### P2 — clarity / secondary journey gaps

8. **`/compare` (eval) vs `/compare-cars` (consumer)** — eval board still routable; easy to confuse with car compare. Footer/nav correctly emphasize `/compare-cars`.  
9. **Credits / Stripe labeled test-mode on consumer Credits page** — honest for preview; confusing if production expects live billing without copy change.  
10. **Scout default off** — `/scout` reachable by URL; nav hides until capabilities say UI on. Not a bug; document as external flag blocker.  
11. **Without `SERV_API_KEY`, `/api/need` is form-only** — weaker extraction (offline: “near Dallas” did not produce ZIP; makes empty). Fail-closed OK; UX may feel “dumb” vs SERV-on.  
12. **PR74 crash window residual** — stuck `analysis_in_progress` after winner crash (no auto reclaim by design). Rare; ops/manual.

### Explicitly NOT treated as findings (out of scope / already fixed on this tree)

- Fee `$587` treated as ask on find cards / paid re-fetch charge — covered by PR74 tests (`find-listing-price`, `report-chargeability`, `assemble.fee-refetch`, find-handoff).  
- Find paste-URL after selecting a card — fixed via VIN+token handoff.  
- PR71 experiments / Graph / auth redesign — out of scope.  
- Stylistic rebrand / logo / fonts — preserve; not audited as defects.

---

## 5. Safe test plan for subsequent UI phase (parent-authorizable, no paid calls)

### A. Allowed without keys / without spend

1. Homepage hero/nav/pre-submit (parallel visual OK).  
2. `/find` stages need → budget → confirm (do **not** click Search listings). Validate ZIP/radius Nationwide vs presets; watch for silent `?? 100` when typing ZIP.  
3. `/check` form validation empty states; do not submit Check/Report if Autodev configured in that env.  
4. `/report/sample`, `/reports` empty, `/favorites` empty, `/compare-cars` empty gate.  
5. `/scout` with UI off message.  
6. `/credits` UI render; **do not** start Stripe checkout.  
7. Offline unit/route tests already green (re-run suite below).  
8. Local Next with `AUTODEV_API_KEY=` `SERV_API_KEY=` `STRIPE_SECRET_KEY=` — confirm fail-closed JSON for match/check; demo 401.

### B. Requires explicit parent authorization (paid / credit / provider)

1. Live `/api/match` Autodev (+ SERV radar_guard).  
2. Live `/api/check` or `/api/report` assemble.  
3. Any credit spend / Stripe / webhook.  
4. Radar scan / check-now.  
5. Scout preferLive or SERV planner.  
6. Production visual after real listing data.

### C. Recommended fix-order for later PR (do not implement this turn)

1. Radar `openReport`: pass row/alert `askingPriceUsd` + `miles` + ZIP (or find-context equivalent); fail closed if unusable.  
2. Restore `af-check` on `/check` mount (mirror find pending retry); clear after success.  
3. Stop inventing `100`/`50` radii — prompt for numeric radius when saving watch / when ZIP added after Nationwide.  
4. Manual check spend idempotency (optional follow-on).  
5. Radar credits `return` + pending payload.

---

## 6. Tested vs not tested

### Tested (this turn)

| Item | Result |
| --- | --- |
| Exact SHA+tree identity | OK |
| Route inventory (pages + API) | Code complete |
| CTA → handler → provider matrix | Code + offline HTTP |
| Offline vitest journey subset (17 files / 120 tests) | **all passed** (mocked credits/providers; log `/tmp/t307-offline-tests.log`) |
| Local Next `127.0.0.1:3017` empty paid keys | Pages 200; match/check fail-closed; demo 401; scout off; radar-shaped report → `vin_needs_details` |
| `af-check` write-only proof | Repo grep |
| Consumer copy / PR74 fee+handoff suites | Included in 120 |

### Not tested

| Item | Why |
| --- | --- |
| Live Autodev / SERV / Stripe / Telegram | Hard constraint — no paid calls |
| Production deploy visual / Lighthouse | Parent parallel; this agent offline |
| Real credit spend / double-click on live check | Would charge |
| Scout live preferLive / owner grant | Flags off + would burn Autodev |
| End-to-end browser click-through with listings | Needs Autodev |
| Chromium MCP visual audit | Deferred to parent parallel; local Next used via curl only |
| Upstash multi-instance production race | Needs shared prod Kv |
| Exact Auto.dev fee field provenance | Still residual unknown from PR74 |

---

## 7. External config blockers

| Env / config | Blocks |
| --- | --- |
| `AUTODEV_API_KEY` | Live find/check/radar listings |
| `SERV_API_KEY` (+ optional `SERV_MODEL`, default `gpt-5.4-mini`) | Need extract quality; radar_guard; report prose/judge |
| `UPSTASH_REDIS_*` on Vercel | Paid Autodev dispatch gate (`paid-dispatch-guard`) |
| `STRIPE_SECRET_KEY` (test) + webhook | Credit purchase |
| `DEMO_ACCESS_KEY` | `/demo` shared account |
| `SCOUT_ENABLED` / `SCOUT_UI_ENABLED` / `SCOUT_PAID_EXECUTION` / owner grant | Scout product surface |
| `TELEGRAM_*` | Alert delivery |
| `NEXT_PUBLIC_APP_URL` | Checkout return URLs |

Local offline run observed: `listingsConfigured:false`, `servConfigured:false`, `stripeConfigured:false`, `storage:"file"`.

---

## 8. Explicit non-claims

- **No live production verification** of listing quality, SERV prose, or Stripe.  
- **No complete visual UX audit** — code + offline HTTP + unit/integration only; parent owns homepage/nav visual parallel.  
- **Not claiming “all bugs found”** — focused on reproducible logic/data/journey defects across consumer routes.  
- **PR71 / Graph / new services / auth redesign** out of scope.  
- **No fixes implemented**; no product commits; no PR from this phase.  
- Artifact path only under `artifacts/`; do not treat as publishable product change.

---

## 9. Offline command receipts

```text
# Identity
git rev-parse HEAD  → 06f8bad3d03402662fd821f8617aff3c5b51c891
git rev-parse HEAD^{tree} → ca6f9baad8ea3010d9a59a075a6e5f8294ca311d

# Vitest (mocked; 17 files)
npm test -- [find-handoff, idempotency, chargeability, price-badge, find-match, …]
→ Test Files 17 passed / Tests 120 passed

# Local Next empty keys (no Autodev/SERV/Stripe)
npx next dev -H 127.0.0.1 -p 3017
curl pages → 200
POST /api/match → listings_unconfigured
POST /api/check → listings_unconfigured
POST /api/report {vin,zip} → vin_needs_details [asking price, mileage]
GET /demo → 401
GET /api/scout → enabled:false
```

---

## 10. Parent return summary (one screen)

**Top defects to fix next (UI/logic PR):** (1) Radar full-analysis omits known price/miles → `vin_needs_details`; (2) Check credits path never restores `af-check`; (3) ZIP/Nationwide silently snaps to 100 mi / flip watch hardcodes 50.  
**Paid-vs-free highlight:** Home submit = free client nav; Need = SERV-if-keyed; Match/Radar scan = Autodev (+ SERV guard); Check preview = Autodev+NHTSA free of credit; Report = 1 credit + Autodev+SERV+gov; Scout = separate gated burn; Credits = Stripe.  
**Safe next phase:** UI/empty-state/radius/restore fixes + offline tests; **do not** authorize live Autodev/SERV/Stripe until scoped.
