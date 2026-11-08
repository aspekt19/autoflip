## Summary

Scoped root-cause fixes for t310 scenario1 + scenario2 findings after PR75 consumer cycles. **HOLD — no merge/deploy until parent independent review + owner ACCEPT.**

Base published main: `e6eb269…`. No live provider / SERV / credit / secret / env / Graph / new-service changes in this PR.

### Scenario 1 (prior) + homepage
1. **Homepage Find cars** — client `router.push` after `preventDefault` could leave the hero unchanged. **Fix:** native `GET /find` (`note` + `mode`).
2. **CX-5 monopoly + duplicate sections** — editorial Compact crossovers re-searched named CX-5. **Fix:** demote already-named models for editorial search; cross-direction VIN dedupe. Empty RAV4 = availability, not invented.
3. **Provenance** — trusted find ask/miles labeled “typed in”. **Fix:** `factSource: "find_feed"` truthful seller-feed notes. PR74/75 trust/credit guards unchanged.
4. **Soft prefs honesty** — AWD / history / running-cost gaps surfaced as honesty lines (no fabricated filters).

### Scenario 2 (new)
1. **Named prefs as hard exclusions** — “looking at CR-V, Tucson, Sportage” became `openToOtherMakes=false` (“Other makes are left out”) because openness required explicit “open to” phrasing. **Cause:** preferences defaulted closed. **Fix:** `preferOpenToOtherMakes` — named makes are preferences unless explicit closed language (`not interested in other makes`, `only a Honda`, …). Confirm UI then keeps other makes in the mix.
2. **All 8 CR-V / no Tucson/Sportage** — CSV shows 8 Honda CR-V only. With closed mandate, named direction still *planned* all three models; absence of Tucson/Sportage in results is consistent with empty/filtered provider returns within ZIP50 / $15k (not inventable). After open-preference fix, editorial alternatives also search non-named crossovers. **No quotas / no invented Tucson/Sportage rows.**
3. **Number audit / shadow agent** (`fallback_template — number audit failed`; `invented_number, buy_language_on_negative_verdict`) — **Guard kept.** Audit correctly blocks unsafe published prose; template explanation is shown instead. False-positive hardenings only:
   - allow restating mandate budget (`$15,000`) in allowlist / money collect
   - scrub cautionary “before you buy / before purchase” so needs_inspection advisories are not treated as buy recommendations
   - affirmative “good deal — buy it” on insufficient_data still fails (true positive)
   - Proof of AI UX clarifies blocked model text was **not published**
4. **TCO / model comparison / fuel annual cost / reliability-age ranking** — **explicit residuals.** Product does not yet ground TCO or side-by-side model ownership-cost comparison; fuel stays unavailable without FuelEconomy.gov match. Soft-pref honesty mentions these gaps. **Do not claim t310 NL acceptance passed.**

## Test plan

- [x] `npm test` — 627 passed / 108 files
- [ ] Parent opens PR → GitHub CI (workflows on `pull_request`)
- [ ] Independent review; **HOLD merge** until ACCEPT
- [ ] No live Find/report/credit re-run in this agent

## Pins

- Branch: `cursor/find-nav-provenance-ecfd-1033`
- Base: `main` @ `e6eb269ec725ed500a77549f420a8b5a9086a727`

## Not claimed

- Invented Tucson/Sportage/RAV4 inventory or equal model quotas
- Grounded TCO / model-vs-model ownership cost / always-available fuel
- Removal of number-audit protection or “unsafe SERV text was safe”
- Live browser re-verification; merge; deploy; env/model/Graph/PR71
