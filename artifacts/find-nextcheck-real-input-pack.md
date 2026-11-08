# Find next-check REAL input pack (parent Flip / Scenario2)

Schema: `find-nextcheck-real-input/v1`  
Honesty: Built from **ordinary Find next-check response fields** after a real search — not PR63 fixture echo. CSV VINs from screenshots are **unverified**; do not paste as live VIN input.

## Required fields (from live `POST /api/find/next-check`)

```json
{
  "schemaVersion": "find-nextcheck-real-input/v1",
  "allowedCheckIds": ["free_gov_recalls", "free_gov_safety", "compare_observed_asks", "run_full_analysis", "get_history_report", "widen_or_nationwide"],
  "appliedCheckIds": [],
  "clampDiag": null,
  "freeGovReceipts": [],
  "recentOutcomes": [],
  "needHints": {
    "conditionPriority": "inspection_first",
    "yearBandResolved": true,
    "yearMin": null,
    "budgetUsd": 15000,
    "zipPresent": true,
    "distanceMiles": 50,
    "listingsHaveVin": "unknown_until_cards"
  },
  "honesty": "Populate allowedCheckIds + freeGovReceipts from a live next-check JSON after Find. Empty receipts array means pre-check; do not invent cards/history/prices."
}
```

## How to fill (sanctioned)

1. Run ordinary Scenario2 Find → Confirm (no year floor) → Results.
2. Copy from the next-check network response (or UI note after auto-continue):
   - `allowedChecks` → `allowedCheckIds`
   - `freeGovReceipts` → as-is (server-owned)
   - `clampDiag` if present
   - `appliedCheckIds`, `loop.reason`
3. Optional in-process: `exportFindSearchContextSanitized(loadFindSearchContext(...).record)` — **no public HTTP export route** in this change; Flip tooling only.

## Profile switch plan (parent only)

| Step | Action |
|------|--------|
| A | Set `SERV_PROFILE_MODEL_FIND_NEXT_CHECK=claude-sonnet-5.5` on Vercel → deploy → one Scenario2 |
| B | Set `SERV_PROFILE_MODEL_FIND_NEXT_CHECK=gpt-5.6-sol` → deploy → one Scenario2 |
| C | Unset override → Mini |
| Never | Fable; simultaneous multi-caller; ALLOW_UNLISTED |

Expect after fix: `autonomousServ=true` or, if fallback, `clampDiag.deniedCheckId` visible + free-gov receipts listed per card + loop `evidence_changed_replan`.
