## Summary

Ordinary NL Find can now autonomously run **allowlisted free public NHTSA vehicle checks** (reuse Scout free-gov: recalls/complaints, vPIC, NCAP safety) when condition / hidden-risk matters — **before** settling on `compare_observed_asks` → `[unchanged_state]`.

Also fixes Scenario2 Budget wizard **Continue silent no-op** when shopper chooses **No year floor — use budget band** (`any`): null floors are no longer treated as unanswered.

Server owns free-gov receipts on search context → evidence fingerprint change → auto-continue next SERV (no manual Apply). No Report credit. No NMVTIS/Auto.dev new spend. Missing VIN/history stays unknown; make/model recalls ≠ VIN-open status; vPIC ≠ clean history.

## Pins

| Item | Value |
|------|--------|
| Base | `origin/main` @ `73e9f229` (PR #79) |
| Branch | `cursor/find-free-vehicle-checks-ecfd` |
| Tip | `9efc67e2860ff1c870ffe5d7ecc484008a97d532` / tree `ed487db8af46bd3319cc5530b3c6429e313bacdc` |
| Typecheck fix | `b0a2e0eda86728b62ce3e4d6d37e75b507df3f93` / tree `6b804480ddd365949bb3efdbb3efb8285a15aa34` |
| CI cause/fix | `tsc` TS2353: excess `note` on `FindNextCheckInput.need` Pick — dropped in fixtures |
| Default Mini | unchanged (`gpt-5.4-mini`) |
| Fable | **EXCLUDED** from `find_next_check` profile candidates |
| Sonnet/GPT | first-class via `SERV_PROFILE_MODEL_FIND_NEXT_CHECK` |
| FuelEconomy free | still unsupported (Scout rights hold) |

## Root cause — Continue no-op (Scenario2)

`followUps()` treated `yearMin == null && yearMax == null` as **unanswered** even after the shopper picked **No year floor** (`value=any`). `applyFollowUp("age","any")` left null floors with no resolution flag → age prompt could not clear; sequential `/api/need` follow-up posts also dropped prior resolutions. Fix: `yearBandResolved` / `milesCapResolved` distinguish explicit no-floor/no-cap from unanswered; Continue applies answers locally first, syncs once with preserved fields, surfaces errors next to the wizard (no forced arbitrary year).

## Root architecture (free-gov)

```
NL Find → /api/match (mint searchContextToken + listings)
       → UI auto POST /api/find/next-check
       → claim fence → find_next_check SERV (allowlist includes free_gov_*)
       → applyFindNextCheck (freeEvidence: true, research: false)
       → executeFindFreeGovCheck → Scout createLiveFreeGovPort (vPIC/recalls/NCAP)
       → store freeGovReceipts on FindSearchContext
       → decideFindNextCheckLoop (freeGov fp change → evidence_changed_replan)
       → UI auto-continues → next SERV with freeGovEvidence facts
```

Preserve: owned context/claims/idempotence/provider-failure stop/no loop on unchanged/no artificial step quota/report-credit separation. Soft preferred models + geo untouched. Sanitized same-REAL export includes `freeGovReceipts`.

## Tests (offline — NOT live NHTSA/SERV proof)

- Scenario2: `any` → yearBandResolved, age prompt clears, no forced year, no `clarify_year_band` re-offer
- `find-next-checks`: hidden problems → free_gov before compare; price-only skips free
- `find-free-gov` / loop / path / orchestrator / route free_gov receipts → `evidence_changed_replan`
- Fable blocked on `find_next_check` profile resolve

## CI

Parent opens/updates PR #80 → `pull_request` workflows. Agent made **no hosted/provider/credit calls**.

## Remaining gaps (GAP ≠ completed goal)

- Parent Scenario2 browser retest after publish (this Continue fix + free-gov)
- Independent review before merge; do not raise ACCEPT as completion
- Live NHTSA + keyed SERV next-check on ordinary Find still parent sole live caller
- FuelEconomy remains unavailable on free surface
- Paid NMVTIS / Report history still user-action only (correct)

## Honesty

Offline mocks are **NOT live proof**. Free gov ≠ title clearance. No invented cars/history/prices. No forced year for explicit no-floor.
