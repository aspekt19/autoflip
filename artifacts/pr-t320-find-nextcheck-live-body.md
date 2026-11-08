## Summary

**NARROW ACCEPT follow-up (NOT RELEASE READY — do not merge/deploy as release).**  
Ordinary Find next-check path: owned search context → keyed SERV allowlist choose → apply → rematch with **NEW need** → grounded shortlist. Auto-starts after search when SERV keyed.

Base = main `ba6e127` (PR77). Branch `cursor/find-nextcheck-live-apply-ecfd-1033` / PR #78.

### Pins

| Pin | Value |
| --- | --- |
| Branch | `cursor/find-nextcheck-live-apply-ecfd-1033` |
| Base | `ba6e127d399afa8b64126dcf35da73fdd8f81158` |
| **Tip** | `cb34eb3c46ea82de7d3a0314ecbd0b66db023300` / tree `334423c783405c6436cedc7b844d2ec80d3f8b62` |
| Feat commit | `cb34eb3c46ea82de7d3a0314ecbd0b66db023300` (same if tip=feat) |
| Prior NARROW ACCEPT | `dbf705e19cd0cb01c97f0b22aa157d9f01e7bd49` |
| Prior CI | `42509335775` SUCCESS (704) |

### Gap closed in this iteration

1. **Auto-start:** after `/api/match`, when `servNextCheckEnabled`, UI calls next-check once per `searchContextToken`.
2. **Claims:** user-owned SET NX fence + spend log; concurrent same-action → one SERV HTTP; replay receipts.
3. **Server authority:** `searchContextToken` from match; client need/listings/appliedCheckIds not trusted.
4. **Stale year fix:** rematch uses NEW need/refine from apply (server rematch preferred; client helper ignores UI year drafts).
5. **Keyless:** `autonomousServ=false` / `deterministic_fallback` — does not masquerade.
6. **No report-credit debit** for ordinary next-check/search.
7. First-class `gpt-5.6-sol` / `claude-fable-5` retained.

### Tests (scope) — 716 total

- `find-next-check-claim.test.ts` — concurrent/replay/fingerprint/spend log
- `find-next-check-orchestrator.test.ts` — owned token, NEW need rematch, concurrent one HTTP, keyless label, evidence→planner
- `find-next-check-ui.test.ts` — auto-start gate + stale year ignore
- Prior seam + shortlist allowlist tests

### Remaining gaps (honest — re-review)

- Not full Scout autonomy / multi-turn Flip-hosted live cycle proof.
- Model pack / PR63 ledger = controlled scenario, not representative full-cycle.
- Production `BASE_MODEL` still Mini until Flip sequential spend.
- No self-merge; no hosted calls from this agent.

### Flip CLI artifact

`/opt/cursor/artifacts/flip-pr78-decision-cli-cb34eb3.tar.gz` — bundled `compare-harness.mjs`, Node 22+, dry-run/live; pins include this tip.
