## Summary

**t307 / t310 / t313 / t314 workstream** — strengthen the consumer NL Find path after PR75. **HOLD — no merge/deploy until parent independent review + owner ACCEPT.**

Base: published `main` @ `e6eb269…`. No live provider / SERV / credit / secret / env / Graph / new paid services / PR71.

Owner intent (t314): such and similar scenarios must work — coherent path, not two-phrase overfit.

### Product path addressed

| Stage | Implemented in this PR | Still residual |
| --- | --- | --- |
| NL intent → prefs | Named models default to **preferences** (open) unless explicit closed language; paraphrase + negation tests | SERV replan / bounded tool choices beyond need extract |
| Model/candidate generation | Named group searches **all** named models; editorial extras demote already-named search targets | Deeper body/use inference beyond editorial tables |
| Inventory across models | **Round-robin diversify** so first-named model cannot fill the 8-card window; cross-direction VIN dedupe; confirmed-empty vs coverage-failure copy | Live Tucson/Sportage empty in a given ZIP/budget remains availability |
| Comparison / ownership cost | **Observed-from-search** median ask/miles/year per model on results (sourced cards only) | Grounded TCO, EPA always-on fuel, model reliability ranking |
| Condition / history / clarifications | Soft-pref honesty (AWD optional, age unknown, history/condition, running cost); Proof-of-AI audit UX | Progressive structured follow-ups beyond use/budget/geo; VIN history product |
| Homepage entry | Native `GET /find` submit | — |
| Provenance Find→report | `factSource: "find_feed"` truthful labels | — |
| Number audit | **Guard retained**; FP harden (mandate budget; cautionary before-purchase); blocked prose not published | Full SERV explain quality (not claimed fixed) |

### Scenario evidence (production already ran — not re-run here)

- S1: CX-5 domination + duplicate sections + seller-feed vs typed-in
- S2: hard exclusion UI; 8× CR-V; report `e6aadbfa…`; audit `invented_number, buy_language_on_negative_verdict` → template fallback (**protection kept**)

### Offline evidence

- `npm run typecheck` pass (fixes prior CI `listingCached` type error)
- `npm test` — **642** passed / **110** files (includes paraphrase/negation/soft-vs-strict, diversify, observed snapshots, audit FP)

### Not claimed / do not declare t310–t314 done

- Invented inventory or equal model quotas
- Full grounded TCO / always-available fuel / reliability scores
- Removal of number-audit or “unsafe model text was safe to publish”
- Live browser / provider / credit re-verification
- Merge, deploy, env/model/Graph/PR71

## Test plan

- [x] Local typecheck + full vitest
- [ ] GitHub CI green on this head after push
- [ ] Parent independent review; **HOLD merge** until ACCEPT
