## Summary

Scoped root-cause fixes for four production findings after PR75 consumer cycle (Find→report `e5344d54…` / CX-5 `JM3KFBDM2J0424661`). **HOLD — no merge/deploy until parent independent review + owner ACCEPT.**

1. **Homepage Find cars** — `HomeSearch` used client `router.push` after `preventDefault`, so a soft-nav failure left the hero form unchanged. Native `GET /find` with `note` + `mode` is now the submit contract (no redesign).
2. **t310 grouping / selection** — With open Mazda CX-5 + Toyota RAV4, editorial **Compact crossovers** re-prioritized preferred makes and searched **CX-5 again**, duplicating the same cards under **Models you named**. Fix: demote already-named models for editorial extras (search CR-V etc.), skip segments with no alternative, and cross-direction VIN dedupe. **Does not invent RAV4 rows** when inventory/provider returns empty.
3. **Provenance false** — Trusted find handoff overlaid feed ask/miles into assemble, which always labeled them “typed in”. `factSource: "find_feed"` now stamps truthful seller-feed notes; manual Check keeps typed-in wording. PR74/75 trust/credit guards unchanged (token, owner, VIN/VDP, ZIP bind, once-charge, fail-closed).
4. **Soft prefs / gaps** — Note soft prefs (AWD, hidden problems/history, running cost/fuel) surface as **honesty lines** on confirm + results. No fabricated AWD/history/fuel filters or forced questionnaire fields.

## Test plan

- [x] `npm test` — 623 passed / 107 files
- [x] `npm run build` — ok
- [ ] Parent independent review (no live inference/API/credit re-run in this PR)
- [ ] HOLD merge until ACCEPT

## Pins

- Base: `main` @ `e6eb269ec725ed500a77549f420a8b5a9086a727`
- Branch: `cursor/find-nav-provenance-ecfd-1033`

## Not claimed

- Equal make/model quotas or invented RAV4 listings
- New drivetrain/history/fuel search filters or paid data
- Live browser re-verification of homepage / find / report
- Merge, deploy, env/model/Graph/PR71 changes
