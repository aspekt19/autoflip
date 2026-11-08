## Summary

**NOT RELEASE READY — independent review next. Do not merge until parent ACCEPT.**

Fixes owner live failure on published PR78 (`8640995`): ordinary Find settled on **`Code fallback … [no_keyed_autonomy]`** despite GPT-5.4 Mini OpenServ spend, and CR-V cards showed **`Mazda/Toyota`** under Honda titles.

Base = main `8640995bc45716906fcbc3c01d8facdc698c80b3` (PR78 merged). Branch `cursor/find-nextcheck-keyed-runtime-ecfd`.

### Root cause (Gate A / core)

1. **Misleading stop reason:** keyed SERV path that fell closed to deterministic allowlist was labeled `no_keyed_autonomy`, same as missing `SERV_API_KEY`. Owner Mini spend (+8) is consistent with `find_next_check` being attempted then failing (timeout/parse) while need_extract still counted.
2. **`find_next_check` timeoutMs=8s** was too tight for Mini on the ordinary Find→auto-next-check path (known Mini cold-latency class). Raised to **25s** (not a blind scout 45s raise).
3. **No actionable public diag** on the Retry note — failureDiag/category not surfaced.

### Fixes

| Fix | Detail |
| --- | --- |
| Loop reasons | `no_serv_key` vs `serv_deterministic_fallback` (keyed but SERV failed closed) |
| `keyedAutonomyDiag` | Secret-free `configHint` + failureCategory/reasonCode on next-check JSON + UI note |
| Timeout | `find_next_check` 8s → 25s |
| Card provenance | `whyThisCar` never uses joined preferredMakes (`Mazda/Toyota`) as listing make |
| Fable | Removed from Flip paid shortlist / production selection (owner t321) |

### Offline regression (masks green mocks)

`src/app/api/find/next-check/next-check.route.test.ts` — **`keyed + SERV timeout/abort → serv_deterministic_fallback (NOT no_keyed_autonomy)`**

Also: loop unit tests, why-car CR-V slash test, orchestrator keyless → `no_serv_key`.

### Deploy configuration (parent / Vercel — NO secret values)

1. **`SERV_API_KEY`** must be set on the **same** Vercel project/deployment that serves **both** `/api/match` and `/api/find/next-check` (Production + Preview if used).
2. Optional: `SERV_BASE_URL`, `SERV_MODEL` / `SERV_PROFILE_MODEL_FIND_NEXT_CHECK` — production default remains **gpt-5.4-mini**.
3. If mint said keyed but next-check is keyless, response `keyedAutonomyDiag.configHint` starts with **`ENV_DRIFT:`** — fix env on that function, do not invent keys in logs.
4. If keyed but fallback: inspect `failureDiag.category` / `reasonCode` (`serv_timeout_or_network`, `invalid_json`, `check_id_not_in_allowlist`, …) — not “missing key”.
5. **Do not** set Fable as production profile model.

### Pins

| Pin | Value |
| --- | --- |
| Branch | `cursor/find-nextcheck-keyed-runtime-ecfd` |
| Base | `8640995bc45716906fcbc3c01d8facdc698c80b3` |
| Tip | `8629b4bfd4e84a33c72c214800e6f3b98448ea0c` / tree `b6f0ead841b554a59239b9273e052c63a0c2fcfd` |
| Implement | `2050cb920f6e9a4821a0f23022a2da8381611ad2` / tree `8216b5a774f99652e7c9bcef7884b31d5ff20764` |
| CI | Pending PR open — workflow is `pull_request` only; local **737** tests green. Parent ManagePullRequest to start CI. |
| PR create | Agent `gh` 403 — body artifact for parent ManagePullRequest |


### Remaining

- Parent retest same consumer phrase on Preview/Prod after deploy env confirmed.
- Hash dealer links / TCO / condition scores out of scope.
- **No hosted SERV/provider/credit calls from this agent.**
