## Summary

Follow-up after PR #77 merge (`ba6e127`): **live Find next-check SERV/API apply + rematch**, plus first-class allowlist for **`gpt-5.6-sol`** / **`claude-fable-5`**. Base = new main. **No self-merge. No hosted calls in this agent.**

### Pins

| Pin | Value |
| --- | --- |
| Branch | `cursor/find-nextcheck-live-apply-ecfd-1033` |
| Base | `main` @ `ba6e127d399afa8b64126dcf35da73fdd8f81158` (PR77 merge) |
| **Implement tip** | `dc66c61c5b8a1f678a90f4282eaf5c6a302e188b` / tree `2d9eb332740b4b4e729ce8fc613c575cef5c56c0` |

### Gap closed (honest)

**Before (PR77):** `proposeFindNextChecks` + `applyFindNextCheck` were code/UI suggestions + offline slice only — **no live `find_next_check` SERV/API apply**.

**This PR:** authenticated `POST /api/find/next-check` → SERV `find_next_check` (when keyed) → clamp to allowlist → `applyFindNextCheck` → if `research`, client rematches via `/api/match` (real inventory). UI button on Find results. Seam tests with mock SERV HTTP (choose / clamp / refuse / no-key fallback).

### Still not claimed / residual honesty

- Seam tests mock SERV HTTP; they do **not** substitute a Flip-hosted live spend cycle.
- Full autonomous Scout loop (multi-turn need→search→next-check→apply→rematch→replan without human) still needs Flip sequential hosted validation.
- No invented TCO/history/best-car; production `BASE_MODEL` remains Mini until Flip cycle.

### Shortlist (first-class, no ALLOW_UNLISTED)
1. `claude-sonnet-5.5` baseline  
2. `gpt-5.6-sol` next  
3. `claude-fable-5` if warranted  

### Offline evidence
`npm run typecheck` + `npm test` → **704** passed

### Open PR
`gh` createPullRequest denied for this integration — open manually:  
https://github.com/aspekt19/autoflip/pull/new/cursor/find-nextcheck-live-apply-ecfd-1033  
Body: this file.
