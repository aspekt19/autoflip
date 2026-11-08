## Summary

**NOT RELEASE READY — do not merge/deploy as release.**  
Ordinary Find: owned `searchContextToken` → keyed SERV allowlist choose → apply → rematch with **NEW need** → **automatic continuation** until grounded stop / clarification / provider failure / unchanged-state loop-guard. **No arbitrary hidden step quota.**

Base = main `ba6e127` (PR77). Branch `cursor/find-nextcheck-live-apply-ecfd-1033` / PR #78.

### Pins (update on tip push)

| Pin | Value |
| --- | --- |
| Branch | `cursor/find-nextcheck-live-apply-ecfd-1033` |
| Base | `ba6e127d399afa8b64126dcf35da73fdd8f81158` |
| **Tip** | `10e3832d241dc6d322fb2adc51e4438425d245de` / tree `433237e8d637ce8793535aa7463cb8084d19c86e` |
| Prior tip | `1be6bd90b4f3deaea556f1206058480636bb7cdf` |

### Accepted (unchanged)

Token-only server-owned context; NEW-need server rematch; keyed SET NX claim/fence/replay/concurrency → one SERV request per action fingerprint.

### This iteration — repeated autonomous cycle

1. Server `loop` disposition (`decideFindNextCheckLoop`) — continue only when evidence/need changed + remaining automatic research checks; stop on clarification / user-action / grounded / unchanged / provider failure / keyless.
2. UI auto-continues when `loop.continue` + `autonomousServ` (not one-shot only).
3. Widen already-nationwide → no fake research rematch.
4. HTTP route tests: multistep clarify→evidence→replan/stop; concurrency 409; no-key; missing token; rematch failure stop.
5. No report-credit debit; geography/constraints preserved; gpt-5.6-sol / fable-5 retained.

### Scope tests

- `find-next-check-loop.test.ts`
- `find-next-check.route.test.ts` (direct HTTP)
- prior claim/orchestrator/ui/seam + shortlist
- Full suite **731**

### Remaining gaps (honest — re-review)

- **Not full-cycle** until parent Flip hosted live spend validates end-to-end.
- Pack/PR63 ledger ≠ representative full-cycle proof.
- Production `BASE_MODEL` still Mini.
- **Disposition: NOT RELEASE READY.** Independent review required. **Do not merge.**

### Flip CLI

Existing `/opt/cursor/artifacts/flip-pr78-decision-cli-1be6bd9.tar.gz` still valid for model harness (no cosmetic repack). Product loop changes are in-app; parent Sonnet PR78 test may proceed in parallel.
