## Summary

Ordinary NL Find can now autonomously run **allowlisted free public NHTSA vehicle checks** (reuse Scout free-gov: recalls/complaints, vPIC, NCAP safety) when condition / hidden-risk matters — **before** settling on `compare_observed_asks` → `[unchanged_state]`.

Server owns receipts on search context → evidence fingerprint change → auto-continue next SERV (no manual Apply). No Report credit. No NMVTIS/Auto.dev new spend. Missing VIN/history stays unknown; make/model recalls ≠ VIN-open status; vPIC ≠ clean history.

## Pins

| Item | Value |
|------|--------|
| Base | `origin/main` @ `73e9f229` (PR #79) |
| Branch | `cursor/find-free-vehicle-checks-ecfd` |
| Default Mini | unchanged (`gpt-5.4-mini`) |
| Fable | **EXCLUDED** from `find_next_check` profile candidates |
| Sonnet/GPT | first-class via `SERV_PROFILE_MODEL_FIND_NEXT_CHECK` |
| FuelEconomy free | still unsupported (Scout rights hold) |

## Root architecture

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

Preserve: owned context/claims/idempotence/provider-failure stop/no loop on unchanged/no artificial step quota/report-credit separation. Preferred models soft + geographic constraints untouched.

Sanitized same-REAL export: `exportFindSearchContextSanitized` includes `freeGovReceipts` (no credentials/PII). Comparison plumbing did not delay free-tool integration.

## Tests (offline — NOT live NHTSA/SERV proof)

- `find-next-checks`: hidden problems → free_gov before compare; price-only path skips free
- `find-free-gov`: candidate select + mock execute honesty bounds
- `find-next-check-loop`: freeGov fingerprint → continue
- `find-path` vertical slice: free before compare; history still proposed
- orchestrator + route: free_gov_recalls receipts → `evidence_changed_replan` (mock port / fetch labeled offline)
- flip shortlist: Fable blocked on `find_next_check` profile resolve

## CI

Parent opens PR → `pull_request` workflows. Agent made **no hosted/provider/credit calls**.

## Remaining gaps (GAP ≠ completed goal)

- Parent Scenario2 browser defects (in progress) — forward when ready
- Independent review before merge; do not raise ACCEPT as completion
- Live NHTSA + keyed SERV next-check on ordinary Find still parent sole live caller
- FuelEconomy remains unavailable on free surface
- Paid NMVTIS / Report history still user-action only (correct)
- Comparison harness remains sanitized export only — no fixture-echo claimed live

## Honesty

Offline mocks are **NOT live proof**. Free gov ≠ title clearance. No invented cars/history/prices.
