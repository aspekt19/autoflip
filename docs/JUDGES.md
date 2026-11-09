# Lemonless — judge brief (SERV Hackathon)

**Honesty rule:** Every number, screenshot, or SERV claim below either links to a file/run in this repo (with id, model, and timestamp when recorded) or is marked **not yet run / pending live run**. Do not treat UI chrome or unlabeled fixtures as live SERV proofs.

Live preview: [autoflip-umber.vercel.app](https://autoflip-umber.vercel.app/)  
Sample report (labeled economics only; agent revision **not yet recorded**): [/report/sample](https://autoflip-umber.vercel.app/report/sample) — see [`docs/serv-fixture-audit.md`](serv-fixture-audit.md).

---

## What Lemonless does

| Flow | What the shopper does | Sign-in | Code entry |
| --- | --- | --- | --- |
| **Find** | Describe a need → ranked shortlist → optional full analysis | Required before the need form | [`src/components/AssistantFlow.tsx`](../src/components/AssistantFlow.tsx), Find SERV loop in [`src/server/find-next-check-orchestrator.ts`](../src/server/find-next-check-orchestrator.ts) |
| **Check a car** | Listing URL, pasted listing text, or VIN | Required before the form | [`src/app/api/check/route.ts`](../src/app/api/check/route.ts) → [`src/server/check/run-check.ts`](../src/server/check/run-check.ts) |
| **Full report** | VIN / listing after Find or paid Check handoff | Credits / account | [`src/server/assemble.ts`](../src/server/assemble.ts) |

Screenshots from Playwright fixtures (no live Autodev/SERV/Stripe): [`docs/screenshots/check/`](screenshots/check/) — including signed-out gates (`check-signed-out.png`, `find-signed-out.png`), dealer/marketplace/VIN dossier results. README there documents the fixture VINs.

TypeScript owns every dollar figure (`evaluateListingPrice`, comps, flags). SERV may choose a shopper **action** only inside those facts and gates.

---

## Where SERV / OpenServ actually decides

Profiles live in [`src/server/serv/profiles.ts`](../src/server/serv/profiles.ts). Transport: [`src/server/serv/run.ts`](../src/server/serv/run.ts).

| Step | Profile / code | What happens |
| --- | --- | --- |
| Find — choose next check | `find_next_check` | SERV picks an allowlisted check id; code applies it. Cap: `FIND_SERV_PAID_CALLS_PER_FIND_MAX = 8` in [`src/domain/find-serv-budget.ts`](../src/domain/find-serv-budget.ts). Orchestrator: [`find-next-check-orchestrator.ts`](../src/server/find-next-check-orchestrator.ts). |
| Check — listing extract (optional) | `check_guard`, `listing_extract` | Only when HTML/text needs LLM fill ([`extract-listing.ts`](../src/server/check/extract-listing.ts)). Free Check trail still says `no_serv_step` unless a full-report SERV path ran — **routing free Check through `verdict_decide` is open PR #112 (pending merge), not on this `main` tip.** |
| Full report — shopper verdict | `verdict_decide` | Multipath + JSON `{ verdict, note }`. Wired in [`assemble.ts`](../src/server/assemble.ts) after ordered gates. |
| TS clamp | `resolveVerdictDecision` | [`src/domain/verdict-decide.ts`](../src/domain/verdict-decide.ts) + rails in [`verdict-guardrails.ts`](../src/domain/verdict-guardrails.ts) / gates in [`verdict-gates.ts`](../src/domain/verdict-gates.ts). SERV cannot invent dollars or override park-it / title / VIN withhold. |
| Independent second pass | `verdict_challenge` | [`src/server/agent-second-pass.ts`](../src/server/agent-second-pass.ts) → `runReportVerdictChallenge`; assembled into the trail in `assemble.ts`. |
| Revisions (sample replay) | Live recorder only | Script: `npm run eval:record-serv-revision` ([`eval/record-serv-revision.ts`](../eval/record-serv-revision.ts)). Output path: `fixtures/serv/recordings/verdict-revision.latest.json`. **Not yet recorded** on `main` — sample page shows “Example not yet recorded” ([`sample-report.ts`](../src/server/sample-report.ts), [`serv-revision-recording.ts`](../src/server/serv-revision-recording.ts)). |

### Visible decision trail

UI: [`AgentDecisionTrail`](../src/components/AgentDecisionTrail.tsx) (“How the agent decided”). Schema: [`docs/agent-verdict-schema.json`](agent-verdict-schema.json) ↔ [`src/domain/agent-verdict-schema.ts`](../src/domain/agent-verdict-schema.ts).

- Full reports: trail from `buildAgentVerdictFromReport` ([`agent-trail.ts`](../src/domain/agent-trail.ts)) using real decide/challenge outcomes when `SERV_API_KEY` is set.
- Free Check today: code screening steps + explicit `no_serv_step: true` ([`build-check-agent-verdict.ts`](../src/domain/build-check-agent-verdict.ts)).
- Sample SERV revision screenshots under [`docs/screenshots/serv-trail/`](screenshots/serv-trail/) are **withdrawn as SERV proof** (see that folder’s README).

---

## Agent access (`af_` keys)

| Piece | Location |
| --- | --- |
| Key prefix `af_`, scopes `read` \| `check` \| `find` | [`src/server/agent-auth.ts`](../src/server/agent-auth.ts), [`agent-scopes.ts`](../src/server/agent-scopes.ts) |
| Rate limit **30**/key/UTC minute | [`agent-rate-limit.ts`](../src/server/agent-rate-limit.ts) (`AGENT_RATE_LIMIT_PER_MINUTE`) |
| Idempotency on paid Check/Find | [`agent-check.ts`](../src/server/agent-check.ts), [`agent-find.ts`](../src/server/agent-find.ts) |
| Error envelope (`error_code`, `next_steps`, `credit_spent`, `retry_safe`) | [`agent-envelope.ts`](../src/server/agent-envelope.ts) |
| Verdict schema for agents | [`docs/agent-verdict-schema.json`](agent-verdict-schema.json) |
| REST / MCP / discovery | [`public/llms.txt`](../public/llms.txt), [`public/openapi.json`](../public/openapi.json), [`/.well-known/agent.json`](../public/.well-known/agent.json), OpenServ header note: [`docs/agents/OPENSERV_MCP_AUTH.md`](agents/OPENSERV_MCP_AUTH.md) |
| Developers UI | [`/developers`](https://autoflip-umber.vercel.app/developers) |

### Curl example (placeholders — not a live receipt)

Replace `af_YOUR_KEY` with a real key from `/developers`. This example spends **no** credit (tools/list only).

```bash
# PLACEHOLDER: af_YOUR_KEY — create at /developers; do not commit real keys
curl -s https://autoflip-umber.vercel.app/api/mcp \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer af_YOUR_KEY' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Paid Check (placeholder body — **will settle a free check or 1 credit after success** when the key and inputs are real):

```bash
# PLACEHOLDER inputs — replace before a real run
curl -s https://autoflip-umber.vercel.app/api/v1/check \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer af_YOUR_KEY' \
  -H 'idempotency-key: PLACEHOLDER-idem-1' \
  -d '{"text":"PLACEHOLDER pasted listing HTML or text","url":null}'
```

---

## Recorded SERV evidence in-repo (real runs)

| Artifact | Provenance |
| --- | --- |
| [`eval/results/serv-proof-trace.json`](../eval/results/serv-proof-trace.json) | Live `flip_judge` eval fixture. `generatedAt`: **2026-11-06T09:36:15.626Z**. Response id **`chatcmpl-EhAeeqtS7VTM5hgmyZxDbdz7quzxo`**. Model reported **`gpt-5.4-mini-2026-03-17`**. Disclosure: not customer traffic. Narrative: [`serv-proof-trace.md`](../eval/results/serv-proof-trace.md). |
| [`eval/results/latest.md`](../eval/results/latest.md) / [`latest.json`](../eval/results/latest.json) | Committed `eval:serv` comparison. Generated **2026-11-06T09:35:38.636Z**. 44 pairs; token usage and $0.1024 mini-rate **estimate** (not an invoice) are in that file. |
| [`eval/results/verdict-latest.md`](../eval/results/verdict-latest.md) | Status: **not yet run** (2026-11-06T13:44:21.845Z). No fabricated accuracy %. |
| Sample `/report/sample` agent revision | **Not yet recorded** — needs `npm run eval:record-serv-revision` (costs real SERV credits). |
| Lemonless vs plain-AI comparison scoreboard | **Not on `main` / pending live run** (harness work is not merged as measured jury totals here). |

---

## Honest limitations

| Limitation | Evidence |
| --- | --- |
| Listing **link** mode can fail when sites block fetch (`listing_fetch_blocked`, paste/VIN alternatives) | [`run-check.ts`](../src/server/check/run-check.ts) |
| Recalls are model-year NHTSA coverage, not VIN repair proof; paid history (Carfax/NMVTIS) not connected | Check unknowns / report `dataNotes`; judge guide |
| Free Check trail is code-screening (`no_serv_step`) on current `main`; full-report path has decide+challenge when keyed | [`build-check-agent-verdict.ts`](../src/domain/build-check-agent-verdict.ts); assemble second pass |
| Close-call **multipath** on Find defaults to **code-ranked** reconciliation (`source: "code"`) unless a live multipath result is supplied | [`agent-multipath.ts`](../src/domain/agent-multipath.ts), [`build-find-agent-verdict.ts`](../src/domain/build-find-agent-verdict.ts) |
| Verdict accuracy eval & sample revision recording | **Pending live run** (see artifacts above) |
| Stripe test mode; Auto.dev evaluation plan; preview product | README / [`docs/judge-guide.md`](judge-guide.md) |

---

## How to run tests and evals

Local (no SERV spend):

```bash
npm install
npm run typecheck
npm test
npm run build
npm run test:e2e   # Playwright; Check screenshots under docs/screenshots/check/
```

Live SERV (costs **real OpenServ credits** — do not run blindly in CI):

```bash
# Requires SERV_API_KEY. Exits without inventing scores if unset.
npm run eval:serv
npm run eval:verdict
npm run eval:trace

# Live revision capture for /report/sample (also spends SERV). Gate:
COMPARISON_ALLOW_PAID=1 SERV_API_KEY=… npm run eval:record-serv-revision
```

Eval artifact rules: [`eval/results/README.md`](../eval/results/README.md).

---

## Related docs

- Architecture deep-dive (older, still useful): [`docs/judge-guide.md`](judge-guide.md)
- SERV fixture honesty audit: [`docs/serv-fixture-audit.md`](serv-fixture-audit.md)
- Auth / credits: [`docs/auth-and-credits.md`](auth-and-credits.md)
