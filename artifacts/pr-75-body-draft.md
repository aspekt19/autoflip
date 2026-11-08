<!-- CURSOR_AGENT_PR_BODY_BEGIN -->
## FIRST — Test credit path (Flip-safe?)

**Yes — designed Stripe test-mode checkout is the supported free-of-real-money path.** Full write-up: `artifacts/t308-test-credit-path.md`.

| Question | Answer |
| --- | --- |
| Simulated / no-money purchase intended? | **Yes.** Credits UI is explicitly “Test checkout” / “Buy in test mode”. |
| Can it cause **live** Stripe payment if used as designed? | **No.** `stripeClient()` refuses any non-`sk_test_` key. Live keys never create Checkout. |
| Steps | `/credits` → Buy in test mode → Stripe test card `4242…` → webhook grants → Header balance > 0 |
| Alt for Flip | Reuse existing browser `af_uid` cookie session with credits (Incognito showed **0** — expected). Do **not** new-signup. |
| `AUTOFLIP_DEV_CREDITS` | **Local/dev only** — unset in shared/prod deploy. Do **not** set on production (would seed every new `af_uid`). |
| This PR agent | Did **not** purchase, grant, call Stripe/Autodev/SERV, or run live Find→Full analysis. |

## Duplicate browser outcome (coordination)

Separate thread hit production Find on `autoflip-umber.vercel.app` then blocked at 0 credits → `/credits?need=1`. **No Full analysis, no debit, no report.** Its suggestion to set prod `AUTOFLIP_DEV_CREDITS` is **rejected**. Flip remains sole live Find→Full coordinator.

## HOLD

**Do not merge/deploy until owner review.** This PR does **not** claim a full-site live pass. **PR75 is not published.** Owner approved test purchase/report — not new publication.

## Summary

Scoped product fixes from t307 phase1 + t308 visual/cost audits on published main `06f8bad` / tree `ca6f9ba`, plus **t309** find-context ZIP bind fix. **Base: `main` @ `06f8bad`.** No PR74 protection regress; no PR71/Scout unlock/auth redesign.

**Prior ACCEPT of `f2d25f3` / tree `58b2c55` was ACCEPT of old head only — re-review required for t309.**

## Fixed

1. **P0 Radar handoff** — Full report/Analyze posts known `askingPriceUsd` + `miles` (+ zip) via `buildRadarReportPayload` so VIN-only no longer trips `vin_needs_details` for facts already on the card/alert. Credits redirect stores `af-radar-pending` + `return=/radar`.
2. **P0 Check → credits restore** — reads `af-check` on `/check` mount (mirror Find pending); clears after successful report.
3. **P1 Honest radius** — ZIP after Nationwide no longer invents `100`; watch save requires explicit ZIP+radius (no silent flip `50` / personal `?? 100`).
4. **Skip to content** — root cause: `overflow-x:hidden` + absolute `top:-48px` clip + shared z-index under sticky header. Fixed with `position:fixed` + focus transform (`artifacts/t308-skip-link-root-cause.md`).
5. **Mileage units** — “Maximum mileage in miles”; check VIN mileage labeled “(miles)”.
6. **400px homepage** — narrow media tweaks + centered bar; screenshots under artifacts / `/opt/cursor/artifacts/`.
7. **/check invalid VIN** — proven: handoff returns `invalid_vin`; submit disabled + inline alert when VIN non-empty but check-digit invalid (avoids misleading `vin_required` copy).
8. **t309 P0 Find Full analysis trust refusal** — mint preferred Autodev **dealer** `retail.zip` over find-session **search** ZIP; card CTA claims `need.zip` → `verifyFindAnalysisContext` `tampered_facts` / exact UI *no longer trusted* / 0 charge on Gateway Mazda CX-5 (VIN `JM3KE4CY7G0753111`, search 68114). Fix: mint binds `needZip ?? listing.zip`. Token/owner/VIN/VDP/expiry/miles/forged-ZIP checks **unchanged**. Details: `artifacts/t309-find-context-zip-mismatch.md`.

## Deferred (out of scope / residual)

- Manual check UUID spend-key double-debit class (PR74 residual)
- Report share/owner gate; compare vs compare-cars clarity
- Reports/favorites empty honesty copy (document only unless trivial)
- `/scout` remains grant-gated
- **Did not claim full-site live pass**
- Pre-deploy Kv findctx rows still hold dealer ZIP until shopper runs Find again

## Evidence / CI

| Item | Value |
| --- | --- |
| Base | `main` @ `06f8bad3d03402662fd821f8617aff3c5b51c891` |
| Base tree | `ca6f9baad8ea3010d9a59a075a6e5f8294ca311d` |
| Prior ACCEPT head (superseded) | `f2d25f3f5c03d6b3a9fe0f4fc8c191b6c212dd01` / tree `58b2c55805feb44f03f0663d54c61a3038aafa72` |
| Head | see tip of `cursor/t307-t308-scoped-fixes-ecfd` after push |
| Head tree | see tip of `cursor/t307-t308-scoped-fixes-ecfd` after push |
| Tests | vitest report/find suite green incl. Gateway Mazda t309 cases; typecheck |
| Audits | `artifacts/t307-phase1-audit.md`, `artifacts/t308-credit-cost-map.md`, `artifacts/t308-test-credit-path.md`, `artifacts/t309-find-context-zip-mismatch.md` |

## Test plan

- [x] Offline unit/integration (failure-first radar handoff, af-check restore, geo honesty, invalid VIN)
- [x] Local 400px homepage + focused Skip link screenshots
- [x] Offline t309 Gateway Mazda mint→handoff→`/api/report` (dealer zip ≠ search zip) + forged ZIP still refused
- [ ] Parent Flip sole live Find→Full only after test credits / existing `af_uid` session (re-Find after deploy so mint uses search ZIP)
- [ ] No merge/deploy from this PR until owner review
<!-- CURSOR_AGENT_PR_BODY_END -->
