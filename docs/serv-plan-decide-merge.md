# SERV plan/decide façade — merge order

Resale + Deal Radar (this PR) call a single thin module:

`src/server/serv-plan-decide.ts`

| Entry | Used by | Stub today | Parallel PR plugs in |
| --- | --- | --- | --- |
| `planSearch` / `ports.planResale` | Resale search step 1 | Allowlisted `resale_plan_search` (never invents make/model) | **PR A** — SERV understand + plan any buyer request, multi-model search |
| `decideResale` / `ports.decideResale` | Resale settle / job steps 3–6 | `runResaleSettleServ` (triage → deep → pick → challenge → shopper) | **PR B** — free gov checks in one pass + SERV decide + second check |
| `decideFind` / `ports.decideFind` | Agent Find (API v1 / MCP) personal mode | `runFindSettleServ` | **PR B** (same decide surface) |
| `decideRadarFlip` / `ports.decideRadarFlip` | Deal Radar cron Flip watches | `flip_feasibility` + `radar_review` + negative-profit clamp | **PR B** (or keep Radar adapter if decide stays alert\|skip) |

## Merge order

1. **This PR (Resale + Radar façade)** can merge first — stubs call today’s modules; product behavior stays honest.
2. **PR A** — replace `ports.planResale` via `installServPlanDecidePorts` (or edit the default in `serv-plan-decide.ts`). No need to retouch `/resale` or Radar callers.
3. **PR B** — replace `ports.decideResale` / `decideFind` / optionally `decideRadarFlip`. Shopper second check (`verdict_challenge`) stays inside the decide port.

## Guardrails owned here (code, not SERV)

- Never invent listings, prices, VINs, or response ids.
- Never publish a **negative expected mid-profit** car as the Resale pick.
- Deal Radar Flip: SERV `alert` on a negative-profit VIN is forced to `skip`.
- Agent Find / MCP: **debit only when cars are delivered** (`advanceAgentFindRun`).
- Tests use recorded / mock ids `synthetic-test-*` only — no live paid calls.
- Buyer-facing copy stays plain English (no internal profile tags in UI strings).

## Pricing (unchanged)

Deal Radar plans remain Stripe **TEST** only: Radar **$100/mo**, Radar Pro **$250/mo** (`src/domain/plans.ts`).
