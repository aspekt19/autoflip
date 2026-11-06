# Lemonless Scout — Implementation Plan

**Spec:** `docs/superpowers/specs/2026-11-06-lemonless-scout-design.md`  
**Branch:** `cursor/lemonless-scout-ecfd` (includes merged PR53 + main branding)  
**Base for PR:** `main`

## Self-review (scope / contracts / tests / error-cost)

| Area | Decision |
|------|----------|
| Scope | Domain runner + replay inventory + SERV planner port + OpenServ capability adapter + default-OFF API + tests + eval harness stub. No live paid calls. No UI overhaul. |
| Contracts | Canonical tool IDs, immutable budgets, explicit terminal errors, ≤5 investigate outs, claim taxonomy. |
| Tests | TDD-ish: transitions, budgets, injection, timeout/refusal, zero results, missing config/history, budget exhaustion, idempotent retry, ownership/access/cost, reject→check→replace. Replay uses only `fixtures/autodev-camry.json`. |
| Error/cost | `SCOUT_ENABLED` off; `maxProviderCalls=0`; SERV fail → stop (no silent deterministic autonomy); sample inventory forbidden on production scout path. |

## Increments

1. **Docs** — this plan + design (done in same PR).
2. **Domain core** — types, mandate validation, transitions, budgets, evidence/economics wrappers, gates bridge.
3. **Tool runner** — allowlist execution, provenance, idempotency, listing injection as data.
4. **Loop** — select → tool → verify → reject/replace → finalize/abstain; injectable planner.
5. **Replay inventory** — parse real fixture; empty/unconfigured/unavailable semantics.
6. **OpenServ adapter** — `@openserv-labs/sdk` Agent capabilities wrapping shared tools; document remote prerequisites; tests without starting network server.
7. **API** — `POST /api/scout`, `GET /api/scout/[runId]` behind flag + API key + rate/quota.
8. **Eval harness** — baseline vs scout same pool; mock plans; no fabricated scores.
9. **Verify** — `npm test`, `npm run typecheck`, `npm run build`.

## File map

```
src/domain/scout/{types,mandate,budgets,transitions,tools,evidence,economics,inventory,runner}.ts
src/domain/scout/*.test.ts
src/server/scout/{config,access,store,planner,run,replay}.ts
src/server/openserv/scout-agent.ts
src/app/api/scout/route.ts
src/app/api/scout/[runId]/route.ts
eval/scout-baseline.ts
fixtures/scout/adversarial-*.json  # NOT live evidence
```

## Test commands

```bash
npm test -- src/domain/scout src/server/scout src/server/openserv
npm test
npm run typecheck
npm run build
npx tsx eval/scout-baseline.ts
```

## Follow-ups (not this PR)

- Parent-assigned **bounded** paid SERV planner test only after balance/pricing/≥$5 reserve accounting verified (this worker must not spend yet). Keep `serv_prompt_guard` + content filter + scout-hinted `serv_shadow_agent`.
- Distinguish spend: SERV Reasoning console/credits ≠ marketplace SDK hosting.
- Owner-approved Auto.dev `maxProviderCalls` > 0.
- Remote OpenServ agent deploy + workspace wiring.
- UI for scout investigation list.
- Merge PR53 independently if still open after this stack.
