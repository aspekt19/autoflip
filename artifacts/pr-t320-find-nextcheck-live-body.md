## Summary

Follow-up after PR #77 merge (`ba6e127`): **live Find next-check SERV/API apply + rematch**, plus first-class allowlist for **`gpt-5.6-sol`** / **`claude-fable-5`**. Base = new main. **No self-merge. No hosted calls in this agent.**

### Pins

| Pin | Value |
| --- | --- |
| Branch | `cursor/find-nextcheck-live-apply-ecfd-1033` |
| Base | `main` @ `ba6e127d399afa8b64126dcf35da73fdd8f81158` (PR77 merge) |
| **Implement tip** | `2b607c837f872c95b43a3600a54f9a61210f4e9d` / tree `be7e4067489a4cd68c57af68299fa2c63e69f50e` |

### Gap closed (honest)

**Before (PR77):** `proposeFindNextChecks` + `applyFindNextCheck` were code/UI suggestions + offline slice only — **no live `find_next_check` SERV/API apply**.

**This PR:** authenticated `POST /api/find/next-check` → SERV `find_next_check` (when keyed) → clamp to allowlist → `applyFindNextCheck` → if `research`, client rematches via `/api/match` (real inventory). UI button on Find results. Seam tests with mock SERV HTTP (choose / clamp / refuse / no-key fallback).

### Still not claimed
Full-cycle Scout autonomy; invented TCO/history/best-car; production Mini flip; Gemini blind retry.

### Shortlist (first-class, no ALLOW_UNLISTED)
1. `claude-sonnet-5.5` baseline  
2. `gpt-5.6-sol` next  
3. `claude-fable-5` if warranted  

### Offline evidence
`npm run typecheck` + `npm test` → **704** passed
