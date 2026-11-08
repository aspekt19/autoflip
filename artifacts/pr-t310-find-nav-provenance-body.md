## Summary

**t307 / t310 / t313 / t314 workstream** — strengthen the consumer NL Find path after PR75. **HOLD — no merge/deploy until parent independent review + owner ACCEPT.**

### Exact pins (reconciled)

| Pin | Value |
| --- | --- |
| PR | https://github.com/aspekt19/autoflip/pull/76 |
| Branch | `cursor/find-nav-provenance-ecfd-1033` |
| **Remote head** | `eed8dbeb5370d79d9ce970c985a733fb4a059efe` |
| **Remote tree** | `1f4186549b05310ba0d0cc30e2364ad30bc102b7` |
| Code tip (t314 implement) | `c88bc4a66f1a8de1f1e1a6d11d0dc023de40ee89` / tree `ad61b6c0464f45fc065d4962fb8277c4f6ceed28` |
| Base | `main` @ `e6eb269ec725ed500a77549f420a8b5a9086a727` |
| Superseded failed CI | `1c8262693d1323c512afd01fbdbf308d9a86d0b5` — typecheck `listingCached`; fixed in `c88bc4a` |

**CI:** SUCCESS on code tip `c88bc4a` — https://github.com/aspekt19/autoflip/actions/runs/42502847090  
(`eed8dbe` is docs-only pin update after that green run.)

Parent pin-check that still showed `1c826269` was stale — GitHub ref already had `c88bc4a` pushed.

### Product path addressed

| Stage | Implemented | Residual |
| --- | --- | --- |
| NL prefs | Soft-by-default named models; closed only on explicit exclusion; paraphrase/negation tests | SERV replan beyond need extract |
| Multi-model inventory | Round-robin diversify; VIN dedupe; empty ≠ coverage-failure copy | Live empty inventory in a ZIP/budget |
| Comparison | Observed median ask/miles/year from returned cards only | Grounded TCO / fuel / reliability |
| Soft prefs / provenance / homepage / audit | Honesty gaps; find_feed labels; native GET /find; **number-audit guard retained** + FP harden | Full SERV explain quality |

### Offline evidence
- `npm run typecheck` + `npm test` **642**/110 on `c88bc4a`

### Not claimed
Invented inventory/quotas; TCO/fuel/reliability product; audit removal; live re-runs; merge/deploy.

## Test plan
- [x] Local typecheck + vitest on `c88bc4a`
- [x] GitHub CI SUCCESS on `c88bc4a` (run 42502847090)
- [ ] Parent independent review; **HOLD merge** until ACCEPT
