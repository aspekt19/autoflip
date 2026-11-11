# SERV-visible decision trail (this PR)

Makes SERV’s role readable and verifiable without inventing data.

## Typed step

`ServDecisionStep` (`lemonless.serv_decision_step.v1`) in `src/domain/serv-decision-step.ts`:

| Field | Notes |
| --- | --- |
| step | purpose / kind name |
| by | `SERV` \| `code` |
| modelId | model when known |
| runId | provider response id when SERV succeeded |
| timestamp | ISO or null if not run |
| inputSummary | short digest / evidence list |
| output | decision or skip reason |
| latencyMs / costUsd | only when recorded — never invented |
| status | `ran` \| `skipped` \| `failed` \| `not_run` |

## Stub producer + plug-in points

`src/server/serv/decision-step-producer.ts` normalizes facts into steps and refuses SERV `ran` without a response id.

Sibling cores should call the producer after each finished step:

1. Find need parse (`need_guard` / `need_extract`)
2. Find next check (`find_next_check`)
3. Find / Check / Resale settle (`verdict_decide`)
4. Second check (`verdict_challenge`)
5. Resale plan / triage / pick / challenge
6. Code verification (comps, price badge, gates) with `by: "code"`

Until those producers merge, the journal adapts from stored `DecisionProofRecord`, agent trail, and resale journal rows.

## Buyer UI

Find / Check / Resale / full report show **How this decision was made** (`ServDecisionJournal`). Missing steps say so plainly. Second-check disagreement lowers confidence and is shown.

## Audit

`lemonless.decision_audit_chain.v1` — report sha256 + hash-linked steps. Sealed on `persistReport`. Public `/verify` + `GET/POST /api/verify`. No chain anchoring, no payments.

## Public pages

- `/where-serv-runs` — pipeline + live aggregates from sealed trails only (empty if none)
- `/proof` — multi-arm scaffold from committed provenance only (empty if no live scores)
- `/developers` + `/llms.txt` — MCP/API tools (find, check, resale)

## Merge order

Merge **after** (or independently of) producer PRs A/B/Resale. This PR reads their step records when present; stubs otherwise. No deploy required from this agent.
