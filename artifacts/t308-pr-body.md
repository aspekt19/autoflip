## FIRST — Test credit path (Flip-safe?)

**Yes — designed Stripe test-mode checkout is the supported free-of-real-money path.** Full write-up: `artifacts/t308-test-credit-path.md`.

| Question | Answer |
| --- | --- |
| Simulated / no-money purchase intended? | **Yes.** Credits UI is explicitly “Test checkout” / “Buy in test mode”. |
| Can it cause **live** Stripe payment if used as designed? | **No.** `stripeClient()` refuses any non-`sk_test_` key. Live keys never create Checkout. |
| Steps | `/credits` → Buy in test mode → Stripe test card `4242…` → webhook grants → Header balance > 0 |
| Alt for Flip | Reuse existing browser `af_uid` cookie session with credits (Incognito showed **0** — expected). Do **not** new-signup. |
| This PR agent | Did **not** purchase, grant, call Stripe/Autodev/SERV, or run live Find→Full analysis. |

## Summary

Scoped product fixes from t307 phase1 + t308 visual/cost audits on published main `06f8bad` / tree `ca6f9ba`. **Base: `main` @ `06f8bad`.** No PR74 protection regress; no PR71/Scout unlock/auth redesign.

## Fixed

1. **P0 Radar handoff** — Full report/Analyze posts known `askingPriceUsd` + `miles` (+ zip) via `buildRadarReportPayload` so VIN-only no longer trips `vin_needs_details` for facts already on the card/alert. Credits redirect stores `af-radar-pending` + `return=/radar`.
2. **P0 Check → credits restore** — reads `af-check` on `/check` mount (mirror Find pending); clears after successful report.
3. **P1 Honest radius** — ZIP after Nationwide no longer invents `100`; watch save requires explicit ZIP+radius (no silent flip `50` / personal `?? 100`).
4. **Skip to content** — root cause: `overflow-x:hidden` + absolute `top:-48px` clip + shared z-index under sticky header. Fixed with `position:fixed` + focus transform (`artifacts/t308-skip-link-root-cause.md`).
5. **Mileage units** — “Maximum mileage in miles”; check VIN mileage labeled “(miles)”.
6. **400px homepage** — narrow media tweaks + centered bar; screenshots under artifacts / `/opt/cursor/artifacts/`.
7. **/check invalid VIN** — proven: handoff returns `invalid_vin`; submit disabled + inline alert when VIN non-empty but check-digit invalid (avoids misleading `vin_required` copy).

## Deferred (out of scope / residual)

- Manual check UUID spend-key double-debit class (PR74 residual)
- Report share/owner gate; compare vs compare-cars clarity
- Reports/favorites empty honesty copy (document only unless trivial)
- `/scout` remains grant-gated
- Live browser agent `bc-f607789b-…` still RUNNING — **no message/abort API available** from this run; parent should abort duplicate live Find→Full if still active
- **Did not claim full-site live pass**

## Evidence / CI

| Item | Value |
| --- | --- |
| Base | `main` @ `06f8bad3d03402662fd821f8617aff3c5b51c891` |
| Base tree | `ca6f9baad8ea3010d9a59a075a6e5f8294ca311d` |
| Head | `23ecea06bcc1c7fcf83ff0c9abcee4968aedc450` |
| Head tree | `edcda185e83140ed8a6c839b1070a12e4edfe15d` |
| Tests | vitest **614** passed; typecheck; build; OpenServ boundary; audit 0 high |
| Screenshots | `artifacts/t308-home-400px-after.png`, `artifacts/t308-skip-link-focused.png` (+ `/opt/cursor/artifacts/`) |
| Audits | `artifacts/t307-phase1-audit.md`, `artifacts/t308-credit-cost-map.md`, `artifacts/t308-test-credit-path.md` |

## Test plan

- [x] Offline unit/integration (failure-first radar handoff, af-check restore, geo honesty, invalid VIN)
- [x] Local 400px homepage + focused Skip link screenshots
- [ ] Parent Flip sole live Find→Full only after test credits / existing `af_uid` session
- [ ] No merge/deploy from this PR until owner review

**Open PR:** https://github.com/aspekt19/autoflip/compare/main...cursor/t307-t308-scoped-fixes-ecfd?expand=1
