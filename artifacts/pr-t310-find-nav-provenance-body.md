## Summary

**t307 / t310 / t313 / t314 workstream** — strengthen the consumer NL Find path after PR75. **HOLD — no merge/deploy until parent independent review + owner ACCEPT.**

### Exact pins (reconciled 2026-11-08)

| Pin | Value |
| --- | --- |
| PR | https://github.com/aspekt19/autoflip/pull/76 |
| Branch | `cursor/find-nav-provenance-ecfd-1033` |
| **Remote head** | `c88bc4a66f1a8de1f1e1a6d11d0dc023de40ee89` |
| **Remote tree** | `ad61b6c0464f45fc065d4962fb8277c4f6ceed28` |
| Base | `main` @ `e6eb269ec725ed500a77549f420a8b5a9086a727` |
| Prior failed CI SHA (superseded) | `1c8262693d1323c512afd01fbdbf308d9a86d0b5` / tree `8591320ee8febd66604e8b3ec53dfe9c5f2b74fe` — typecheck `listingCached` on audit FP test; **fixed on c88bc4a** |

Parent pin-check that still showed `1c826269` was stale — GitHub ref + PR `headRefOid` both resolve to **`c88bc4a`**.

Base published main: `e6eb269…`. No live provider / SERV / credit / secret / env / Graph / new paid services / PR71.

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

### Offline evidence

- `npm run typecheck` pass (fixes prior CI `listingCached` type error on `1c826269`)
- `npm test` — **642** passed / **110** files

### Not claimed / do not declare t310–t314 done

- Invented inventory or equal model quotas
- Full grounded TCO / always-available fuel / reliability scores
- Removal of number-audit or “unsafe model text was safe to publish”
- Live browser / provider / credit re-verification
- Merge, deploy, env/model/Graph/PR71

## Test plan

- [x] Local typecheck + full vitest on `c88bc4a`
- [ ] GitHub CI green on **`c88bc4a`** (run after push; prior failure was on superseded `1c826269`)
- [ ] Parent independent review; **HOLD merge** until ACCEPT
