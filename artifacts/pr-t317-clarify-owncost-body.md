## Summary

**t317 on PR #77** — fold parent Mini/Sonnet compare evidence into product: false “search already used once / cannot continue” terminal when provider budget remains; code-owned revised search / evidence next-check. **No live SERV calls. No PR71 merge. No harness re-run of Mini/Sonnet/Gemini.**

### Reviewable tip

| Pin | Value |
| --- | --- |
| PR | https://github.com/aspekt19/autoflip/pull/77 |
| Branch | `cursor/t315-clarify-owncost-ecfd-1033` |
| Base | `main` @ `0aeed3b3fc7611be47eab0eff6b737a9abf869bd` (PR76 published) |
| **Head** |  |
| **Tree** |  |

### Parent evidence folded (not re-run)

- **Mini:** HTTP200 ~5.7s — grounded abstain citing search already used once (**false terminal**: ledger `providerUsed=1` / `maxProviderCalls=3` → **2 searches still available**).
- **Sonnet 5.5:** D1 grounded reject first placeholder VIN `missing_asking_price@price` (not vehicle defect); D2 offline-replay honest abstain — still **no replacement search** while budget remained.
- XOR / bounds / pins valid; **no model winner**; Gemini NEXT by parent only.

### Product fix (this PR)

| Change | Detail |
| --- | --- |
| `searchContinuation` in planner evidence | Code-owned: `providerCallsRemaining`, mid-loop slots, `canReviseSearch`, in-mandate non-duplicate `suggestions` from **observed** pending models |
| scout_plan system prompt | Removes “search once → abstain”; prior search ≠ hard stop while budget remains |
| Offline heuristic | After all-unusable pool / grounded reject: revised `inventory.search` when `canReviseSearch` — not false terminal |
| Scoring | `premature_abstain_with_budget` vs `revised_inventory_search` (offline) |
| Find vertical slice (prior) | clarifications / own-cost / shortlist retained |

Does **not** invent prices/makes; duplicate fingerprints still rejected; credit/fail-closed guards preserved.

### Offline evidence
- `npm run typecheck` + `npm test` → **685** passed
- Scenario: PR63 placeholder ledger (`maxProviderCalls=3`, `providerCalls=1`) → `canReviseSearch=true`

### Flip-only remaining
- Gemini live compare (parent after balances)
- Any paid Mini/Sonnet re-measure after this tip
- Independent review / merge of PR77

### Not claimed
Full-cycle Scout success; model winner; invented usable inventory; harness catalogs as results.
