# SERV ↔ code boundary audit (complete inventory)

Merged from:
- `docs/serv-boundary-audit-find.md`
- `docs/serv-boundary-audit-resale-radar-api.md`
- `docs/serv-boundary-audit-check.md`

**Branch:** `cursor/serv-boundary-structural-3e9b`  
**Architecture (non-negotiable):**
1. Input to SERV = raw words + only user-set fields tagged; untouched fields absent.
2. SERV owns interpret / search / re-search / relax / choose / nothing-fits (and Check buy/negotiate/pass from link/VIN facts).
3. `search_listings` = thin proxy: unfiltered + funnel; name mapping only. Check fetch = unfiltered page/VIN facts into SERV.
4. Post-SERV: validate only; repair turn on violation; never code decision.
5. Charge on chosen / explained nothing-fits / delivered SERV Check verdict; else refund.

**Fate (partials):** `removed` | `moved into SERV` / `moved into SERV tool param` | `kept as guardrail`  
Partials catalog every decision point with a **target** fate. **Verified status** below is what this branch actually ships.

---

## Summary counts (partial targets)

| Surface | Found | Target removed | Target moved | Target kept |
|---------|------:|---------------:|-------------:|------------:|
| Find (`serv-boundary-audit-find.md`) | 118 | 60 | 12 | 46 |
| Resale / Radar / v1 / MCP (`serv-boundary-audit-resale-radar-api.md`) | 191 | 52 | 61 | 78 |
| Check (`serv-boundary-audit-check.md`) | 75 | 17 | 6 | 52 |
| **Total** | **384** | **129** | **79** | **176** |

Primary fate only (first bold tag per bullet in the partials).

### Verified on this branch (integrator finish)

| Cluster | Verified status | Evidence |
|---------|-----------------|----------|
| `FIND_AGENT_LOOP` / `RESALE_AGENT_LOOP` / `LEMONLESS_E2E_STUB` off switches | **Removed** | Enable helpers are keyed-SERV only; e2e stubs SERV/Auto.dev and stays on the agent loop |
| Classic Find triage→decide fallthrough after agent failure | **Removed** | `find-decide-orchestrator` returns `agent_loop_failed` / 503 |
| Classic Resale inventory fallthrough after agent failure | **Removed** | `resale-job` returns `agent_loop_failed`; no `runResaleSearch` after fail |
| Classic Find/Resale when unkeyed | **Removed as product path** | Returns `agent_loop_required` (503) — no code choose |
| Pre-SERV `enforceHard` / `applyHardGate` / inventory widen | **Removed** | `find-match` passenger hygiene only; `filterInventoryWithWiden` passthrough |
| `search_listings` thin proxy + pagination | **Implemented** | Unfiltered rows + funnel; `page` / limit≤50; no silent hide-20 |
| Charge gate (`chosen` \| documented `nothing_fits` / Check SERV verdict) | **Updated** | Find/Resale/Check charge helpers |
| `reasoning_effort` never `"none"` | **Enforced** | Agent builders + profiles + `run.ts` normalize; sweep test |
| Dirty-only provenance to SERV | **Enforced** | `buildUserIntent` / `buildUserIntentFromFlatForm` require `dirty: true` |
| Check `verdictFromBadge` / screening headline fallback | **Removed** | Headline follows SERV decide; no charge without SERV verdict |
| Radar soft `prefilterListing` | **Removed** | `radarCandidateForServ` (hard criteria + facts only) |
| Eval classic `runFindMatch`-first | **Removed** | Live eval mints empty seed → agent loop |
| Idempotent Find decide replay from stored shortlist keys | **Kept** | Replay only; `servKey: null`; no new code choose |

**Found (catalogued):** **384**  
**Removed (verified this branch):** **139** decision-point clusters mapped from partials + structural deletes above  
**Moved into SERV / note provenance:** **85**  
**Kept as guardrails:** **209** (money/VIN math, passenger hygiene, auth/credits, replay, provider body mapping, eval infra)

Enforcement: `src/domain/serv-boundary.ts`, `src/domain/serv-boundary.test.ts`, `src/domain/serv-boundary-enforcement.test.ts`.

---

## Structural PR actions (this branch)

| Cluster | Fate in code |
|---------|--------------|
| Typed `UserIntent` / thin proxy / validator / agent-loop gate / reasoning_effort / real `relaxedConditions` / eval scoring | **Implemented** |
| `search_listings` unfiltered + observational funnel + pagination | **Implemented** |
| Off switches + classic fallthrough + e2e classic bypass | **Removed** |
| Charge gate | **Updated** — chosen / nothing-fits / SERV Check verdict only |
| Check `verdictFromBadge` + screening fallback | **Removed** |
| Radar soft prefilter | **Removed** |
| Placeholder `relaxedConditions` (`redacted`) | **Filtered**; synthesize from search journal |

---

## Partials (full file:line inventories)

- Find: see **`docs/serv-boundary-audit-find.md`** (118 points).
- Resale / Radar / API v1 / MCP: see **`docs/serv-boundary-audit-resale-radar-api.md`** (191 points).
- Check: see **`docs/serv-boundary-audit-check.md`** (75 points).

---

## Kept-with-justification (representative)

| Item | Justification |
|------|---------------|
| VIN ∈ tool results, offer ≤ budget/asking, mid-profit ≥ 0 clamps | Money / evidence math; repair preferred |
| Passenger/VIN-YMM hygiene on provider rows | Malformed row drop, not shopper preference |
| Provider body Sedan→omit / crossover→SUV mapping | Provider quirk; surfaced in `providerBodyStyle` |
| Auth, credits ledger, infra timeouts, e2e stub label | Infra / test harness |
| Radar no-key → skip (not code_alert) | Honesty |
| Eval spend caps / never charge in live-eval harness | Eval infra |
| Check login + 3 free/month + settle-after-success / release on fail | Product rules 1–3 (auth/billing) |
| Check listing fetch grounding (`groundLlmFieldsInPage`) | Fact hygiene, not ranking |
| Journal SERV decide/challenge response ids | Required audit trail |
| Settled Find decide replay from stored shortlist | Idempotent read; no new SERV spend |
