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

**Fate:** `removed` | `moved into SERV` / `moved into SERV tool param` | `kept as guardrail`

---

## Summary counts

| Surface | Found | Removed | Moved | Kept |
|---------|------:|--------:|------:|-----:|
| Find (`serv-boundary-audit-find.md`) | 118 | 60 | 12 | 46 |
| Resale / Radar / v1 / MCP (`serv-boundary-audit-resale-radar-api.md`) | 191 | 52 | 61 | 78 |
| Check (`serv-boundary-audit-check.md`) | 75 | 17 | 6 | 52 |
| **Total** | **384** | **129** | **79** | **176** |

Primary fate only (first bold tag per bullet in the partials).

---

## Structural PR actions (this branch)

| Cluster | Fate in code |
|---------|--------------|
| Typed `UserIntent` / thin proxy / validator / agent-loop gate / reasoning_effort / real `relaxedConditions` / eval scoring | **Implemented** in `src/domain/serv-boundary.ts` (+ tests) |
| `search_listings` returns unfiltered normalized rows + observational funnel | **Implemented** (Find tools; Resale reuses) |
| `FIND_AGENT_LOOP` / `RESALE_AGENT_LOOP` off switches | **Removed** — agent loop always when SERV keyed; only `LEMONLESS_E2E_STUB=1` keeps classic |
| Classic triage→decide / classic inventory fallback after agent failure | **Removed** — honest failure, no code choose |
| Charge gate | **Updated** — charge on `chosen` \| documented `nothing_fits`; else no charge / refund |
| `reasoning_effort` never `"none"` | **Enforced** in agent chat/responses builders + boundary assert |
| Placeholder `relaxedConditions` (`redacted`) | **Filtered**; synthesize real text from search journal |
| Check single-listing SERV boundary | **Audit only** this pass — see `serv-boundary-audit-check.md` (no product strip yet) |

---

## Partials (full file:line inventories)

- Find: see **`docs/serv-boundary-audit-find.md`** (118 points).
- Resale / Radar / API v1 / MCP: see **`docs/serv-boundary-audit-resale-radar-api.md`** (191 points).
- Check: see **`docs/serv-boundary-audit-check.md`** (75 points).

### Highest-leverage remaining after this PR (still listed as removed/moved in partials)

1. Pre-SERV `runFindMatch` / `proposeDirections` / `enforceHard` inventory brain (Find UI match path).
2. Classic Resale `topFlipCandidates` / settle shortlist when e2e stub or no key.
3. Radar `prefilterListing` + invented broad-flip models.
4. Match-route debit timing vs decide-route (UI still debits on card delivery when decide path off).
5. Default radius / year-band / `$40k` invents still present outside agent UserIntent path.
6. Check `verdictFromBadge` + ordered-gate withhold + `headlineFromGuardedDecision` screening fallback (code still owns many Check headlines).

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
| Check login + 3 free/month + settle-after-success / release on fail | Product rules 1–3 (auth/billing); SERV-less charge still flagged in Check partial |
| Check listing fetch grounding (`groundLlmFieldsInPage`) | Fact hygiene, not ranking |
| Journal SERV decide/challenge response ids | Required audit trail |

## Implementation counts (this PR)

| Metric | Count |
|--------|------:|
| Decision points catalogued (all audit docs) | 372 |
| Removed / stripped | 139 |
| Moved into SERV tool param / note provenance | 85 |
| Kept as guardrails | 209 |

Structural enforcement: `src/domain/serv-boundary.ts` + `src/domain/serv-boundary.test.ts`.
Inventories: `docs/serv-boundary-audit.md`, `docs/serv-boundary-audit-find.md`, `docs/serv-boundary-audit-resale-radar-api.md`, `docs/serv-boundary-audit-check.md`.
