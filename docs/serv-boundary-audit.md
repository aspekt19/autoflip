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
Partials use fate as the **target** structural disposition. **Verified status** below is what the tree actually does now — a row may not claim **Removed** in the verified table unless the symbol is gone or unreachable in production (SERV keyed, non-e2e).

---

## Summary counts (partial targets)

| Surface | Found | Target removed | Target moved | Target kept |
|---------|------:|---------------:|-------------:|------------:|
| Find (`serv-boundary-audit-find.md`) | 118 | 60 | 12 | 46 |
| Resale / Radar / v1 / MCP (`serv-boundary-audit-resale-radar-api.md`) | 191 | 52 | 61 | 78 |
| Check (`serv-boundary-audit-check.md`) | 75 | 17 | 6 | 52 |
| **Total** | **384** | **129** | **79** | **176** |

Primary fate only (first bold tag per bullet in the partials).

### Verified removal status (Task F)

| Cluster | Verified status | Evidence |
|---------|-----------------|----------|
| `FIND_AGENT_LOOP` / `RESALE_AGENT_LOOP` off switches | **Removed** | Enable helpers ignore those env vars (comment-only mentions); only `LEMONLESS_E2E_STUB=1` or missing SERV key skips agent |
| Classic Find fallthrough after agent failure | **Removed** | `find-decide-orchestrator` returns `agent_loop_failed` / 503; no `runFindTriageServ` in the agent-failure block |
| Classic Resale fallthrough after agent failure (`job_agent_loop_fallback`) | **Removed** | `resale-job` returns `agent_loop_failed`; string `job_agent_loop_fallback` absent; no `runResaleSearch` after agent fail |
| Classic triage→decide / classic inventory when e2e stub or no SERV key | **Still present** | `runFindTriageServ` / `runFindDecideServ` still imported; Resale step 2 still calls `runResaleSearch` when agent disabled |
| `search_listings` thin proxy (unfiltered + funnel) | **Implemented** | Find tools + boundary asserts |
| Charge gate (`chosen` \| documented `nothing_fits`) | **Updated** | Find/Resale charge helpers |
| Agent request builders `reasoning_effort` never `"none"` | **Enforced** | `agent-chat-turn` + `serv-boundary` normalize/assert |
| Profile / `run.ts` `reasoningEffort: "none"` (applicationTool chat) | **Still present** | `src/server/serv/profiles.ts` (`report_explain`, `agent_explain`); `run.ts` forces `"none"` when `applicationTool` |
| Pre-SERV `enforceHard` / `applyHardGate` inventory gate | **Still present** | `find-match.ts` `applyHardGate`; `inventory-widen.ts` |
| Check `verdictFromBadge` / screening headline fallback | **Still present** | `run-check.ts` |
| Radar `prefilterListing` | **Still present** | `radar-watch.ts` + `radar-cycle.ts` |
| Non-dirty constraints reaching SERV (UserIntent path) | **Enforced** | `assertNoNonUserSetConstraints` + builders |
| Check single-listing product strip | **Audit only** | See Check partial |

**Verified removed / unreachable (production keyed path):** **3** clusters (off switches; Find agent-fail fallthrough; Resale agent-fail fallthrough).  
**Still present (target removed in partials):** **5** clusters above + classic no-key/e2e paths.  
Enforcement: `src/domain/serv-boundary-enforcement.test.ts` (+ `serv-boundary.test.ts`).

---

## Structural PR actions (this branch)

| Cluster | Fate in code |
|---------|--------------|
| Typed `UserIntent` / thin proxy / validator / agent-loop gate / reasoning_effort / real `relaxedConditions` / eval scoring | **Implemented** in `src/domain/serv-boundary.ts` (+ tests) |
| `search_listings` returns unfiltered normalized rows + observational funnel | **Implemented** (Find tools; Resale reuses) |
| `FIND_AGENT_LOOP` / `RESALE_AGENT_LOOP` off switches | **Removed** — agent loop always when SERV keyed; only `LEMONLESS_E2E_STUB=1` keeps classic |
| Classic triage→decide / classic inventory **fallback after agent failure** | **Removed** — honest failure, no code choose |
| Classic triage→decide / classic inventory for **e2e stub / no key** | **Still present** — labelled harness / unkeyed path only |
| Charge gate | **Updated** — charge on `chosen` \| documented `nothing_fits`; else no charge / refund |
| `reasoning_effort` never `"none"` on **agent chat/responses builders** | **Enforced** |
| `reasoning_effort: "none"` on **profile applicationTool chat** | **Still present** |
| Placeholder `relaxedConditions` (`redacted`) | **Filtered**; synthesize real text from search journal |
| Check single-listing SERV boundary | **Audit only** this pass — see `serv-boundary-audit-check.md` (no product strip yet) |

---

## Partials (full file:line inventories)

- Find: see **`docs/serv-boundary-audit-find.md`** (118 points).
- Resale / Radar / API v1 / MCP: see **`docs/serv-boundary-audit-resale-radar-api.md`** (191 points).
- Check: see **`docs/serv-boundary-audit-check.md`** (75 points).

### Highest-leverage remaining (still present — do not claim Removed)

1. Pre-SERV `runFindMatch` / `proposeDirections` / `enforceHard` inventory brain (Find UI match path).
2. Classic Resale `topFlipCandidates` / settle shortlist when e2e stub or no key.
3. Radar `prefilterListing` + invented broad-flip models.
4. Match-route debit timing vs decide-route (UI still debits on card delivery when decide path off).
5. Default radius / year-band / `$40k` invents still present outside agent UserIntent path.
6. Check `verdictFromBadge` + ordered-gate withhold + `headlineFromGuardedDecision` screening fallback (code still owns many Check headlines).
7. Profile `reasoningEffort: "none"` for applicationTool chat explain paths.

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
