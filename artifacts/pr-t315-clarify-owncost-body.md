## Summary

**t315 follow-up** stacked on frozen PR #76 (`cursor/find-nav-provenance-ecfd-1033` @ `aa1e901`). Implements progressive clarifications, grounded ownership-fuel / condition / model comparison, and bounded Find next-check choices — without inventing TCO, history scores, or a “best car.”

**Base:** `cursor/find-nav-provenance-ecfd-1033` (prefer stacked delta; PR76 head stays frozen for independent review).

### Exact pins

| Pin | Value |
| --- | --- |
| Follow-up branch | `cursor/t315-clarify-owncost-ecfd-1033` |
| Stack base (PR76) | `cursor/find-nav-provenance-ecfd-1033` @ `aa1e9010d041105717b19a2a1e36c9ace7f946a8` |
| PR76 code tip (unchanged) | `c88bc4a66f1a8de1f1e1a6d11d0dc023de40ee89` / docs tip `aa1e901` |

### Scope implemented

| Area | Behavior |
| --- | --- |
| Progressive clarifications | Personal Find asks `age` / `miles` / `condition` when soft prefs leave material gaps; sets `yearMin`, `milesMax`, `conditionPriority` — never AWD as a fake filter |
| Year band | Clarified `yearMin`/`yearMax` override budget editorial band in `proposeDirections` |
| Ownership fuel | `estimateOwnershipFuelCost`: EPA annual/range when FuelFact present; MPG→$ only with explicit miles/year+$/gal; else unavailable honesty |
| Model compare | `compareObservedModels`: observed ask/miles/year + condition unknown_needs_inspection + fuel estimate (unavailable on Find cards without FuelFact) |
| Bounded SERV choices | `proposeFindNextChecks` allowlist + `find_next_check` profile schema; UI shows **code** list (no live SERV call) |
| Paraphrases | Offline tests for scenario2 + NL paraphrases |

### Offline evidence
- `npm run typecheck` + `npm test` → **657** passed

### Hard rules kept
No invented numeric costs/history; unknown/known separation; no paid data; no inference/provider/live browser calls; credit guards / fail-closed / number audit untouched; PR76 head not modified.

### Not claimed / true blockers
- Live inventory / SERV / credit re-runs stay with parent
- EPA fuel on Find cards still requires full analysis FuelFact (honest unavailable until then)
- No self-merge/publish

## Test plan
- [x] Local typecheck + vitest (657)
- [ ] Parent opens/updates PR with base = `cursor/find-nav-provenance-ecfd-1033`
- [ ] Parent independent review of PR76 continues undisturbed
- [ ] HOLD merge until owner ACCEPT
