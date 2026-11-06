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

## Chunk update (same PR) — shared orchestrator + honest eval

- `executeScoutSafely` is the single HTTP/SDK entry (capabilities cannot bypass gates).
- Live Auto.dev adapter exists in `providers.ts` using `autodevSearch` + atomic `reserveTotalCall`; requires `SCOUT_PAID_EXECUTION` + key + `SCOUT_MAX_PROVIDER_CALLS_HARD_CEILING`. **Not exercised for spend in this worker.**
- Replay uses the same `InventoryAdapter` / runner contracts; listing rows tagged `sample`; API returns `isFixture` + `presentation.kind=fixture_replay`.
- Client balance attestation **rejected**; server paid-execution config only.
- Eval: `npm run eval:scout` writes machine-readable metrics; mock planner labeled NOT SERV efficacy.
- Minimal `/scout` UI behind `SCOUT_UI_ENABLED` (default off).

## Configurable measured options (folded from public docs; D≠runtime)

Implemented as flags in `src/server/scout/serv-options.ts` (defaults conservative):

1. `promptGuard` on; content filter forced on.
2. `shadowAgent` off by default (cost); enable only after parent-bounded eval.
3. `strictJsonSchema` + `parseScoutPlanText` refusal/invalid/schema kinds.
4. `kronos` / `multipath` / cache opt-out / effort — available flags, not enabled as improvements without measure.
5. `spend-gate.ts` blocks paid SERV until `SCOUT_VERIFIED_BALANCE_USD` + `SCOUT_SPEND_HARD_CAP_USD` + attestation leave ≥$5 — **does not** invent a tokens×rate ceiling.

Research notes attached to the agent are **working source material** only. Do not reuse researcher `fetchedAt` timestamps as this worker’s metadata. Prefer source links + implemented SDK/code interfaces over “D” tags as verification.

## Follow-ups (not this PR)

- Parent-assigned **bounded** paid SERV planner test only after verified balance + conservative hard cap (this worker must not spend yet). No wallet/provision/platform `generate()` bypass.
- Optional measured A/B: shadow on, multipath on policy prompts, effort medium — one variable at a time.
- Distinguish spend: SERV Reasoning console/credits ≠ platform agent hosting credits.
- Owner-approved Auto.dev `maxProviderCalls` > 0.
- Remote OpenServ agent deploy + workspace wiring.
- UI for scout investigation list.
- Merge PR53 independently if still open after this stack.
