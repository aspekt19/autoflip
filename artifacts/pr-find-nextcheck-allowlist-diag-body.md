## Summary

Fixes PR80 Scenario2 live fail: `schema_mismatch/check_id_not_in_allowlist` → deterministic `free_gov_recalls` with unused receipts / no rematch loop.

**Root cause (mechanism, evidenced in code + live diag class):** static `find_next_check` JSON-schema `checkId` enum listed the **full** `FIND_NEXT_CHECK_IDS` catalog while runtime `allowedChecks` is a ≤6 subset. Constrained decoding can emit a schema-valid id outside the live allowlist → clamp fail. Live screenshot proves that failure class; denied raw id was not previously surfaced.

**Fix:** bind request `jsonSchemaOverride` enum to **live allowlist only**; document Scout `evidence.gov_*` → `free_gov_*` aliases; surface bounded `clampDiag` (denied id + allowlist); continue loop when free-gov receipts land even after deterministic fallback; show per-card receipt lines in UI.

No hosted/provider/credit calls. Mini unchanged. Fable excluded. Sonnet 5.5 / GPT-5.6 Sol remain first-class via `SERV_PROFILE_MODEL_FIND_NEXT_CHECK`.

## Pins

| Item | Value |
|------|--------|
| Base | `origin/main` @ `ab5a46b` (PR #80) |
| Branch | `cursor/find-nextcheck-allowlist-diag-ecfd` |
| Default Mini | unchanged |
| Fable | excluded from `find_next_check` candidates |
| Profile override | `SERV_PROFILE_MODEL_FIND_NEXT_CHECK=claude-sonnet-5.5` or `gpt-5.6-sol` |

## Architecture

```
facts.allowedChecks (≤6)
  → buildFindNextCheckChoiceSchema(allowedIds)  // enum = allowlist only
  → runServ(..., jsonSchemaOverride)
  → parse → alias normalize → clampFindNextCheckChoice
  → clampDiag.deniedCheckId + allowlistIds on mismatch (bounded, non-secret)
  → free_gov execute → receipts on search context
  → loop: freeGov fp change continues even after deterministic_fallback
  → UI: per-card receipt lines + denied=… allowlist=[…]
```

## Tests (offline — NOT live SERV proof)

- Schema enum == allowlist subset; catalog still full
- Scout alias → free_gov_recalls; invent id → denied + allowlist in clampDiag
- Live path sends override enum matching allowedChecks
- Loop continues after fallback free-gov evidence
- Sonnet 5.5 + GPT-5.6 Sol resolve on `find_next_check`; Fable blocked; Mini default

## Parent REAL comparison handoff (no empty fixture)

**Sanctioned inputs (already on next-check JSON — no new public endpoint invented):**

From `POST /api/find/next-check` success body (owner-bound token; no credentials):
- `allowedChecks[].id`
- `clampDiag` `{ deniedCheckId, allowlistIds, aliasApplied, reasonCode }`
- `freeGovReceipts[]` (make/model/year/status/summary/factNotes/honesty/toolId)
- `freeEvidenceNote`, `appliedCheckIds`, `loop`, `keyedAutonomyDiag`

**Server helper (same-REAL TTL export, not a public HTTP route today):**
`exportFindSearchContextSanitized(record)` in `src/server/find-search-context.ts` — Flip/parent tooling can call in-process after load by token; do not treat fixture-echo as live.

**ENV switch (parent sole live caller — sequential, not simultaneous):**
1. Vercel project env: set `SERV_PROFILE_MODEL_FIND_NEXT_CHECK=claude-sonnet-5.5` → redeploy/read confirm → run Scenario2 once.
2. Change to `gpt-5.6-sol` → redeploy/read confirm → run Scenario2 once.
3. Unset → Mini default.
4. Never set Fable; never `SERV_PROFILE_MODEL_ALLOW_UNLISTED=1` for this path.

## Remaining gaps

- Parent Scenario2 retest on both Sonnet + Sol after publish
- Independent review before merge
- Optional future: owner-auth HTTP export wrapping `exportFindSearchContextSanitized` (not in this PR)

## Honesty

Denied id diagnostics are bounded identifiers only — never raw model prose or secrets. Offline mocks ≠ live proof. Free gov ≠ title clearance.
