# Lemonless — judge brief (SERV Hackathon)

**Honesty rule:** Every number, screenshot, or SERV claim below either links to a file/run in this repo (with id, model, and timestamp when recorded) or is marked **not yet run / pending live run**. Do not treat UI chrome or unlabeled fixtures as live SERV proofs.

Live preview: [autoflip-umber.vercel.app](https://autoflip-umber.vercel.app/)  
Sample report (labeled economics only; agent revision **not yet recorded**): [/report/sample](https://autoflip-umber.vercel.app/report/sample) — see [`docs/serv-fixture-audit.md`](serv-fixture-audit.md).

---

## What Lemonless does

| Flow | What the shopper does | Sign-in | Code entry |
| --- | --- | --- | --- |
| **Find** | Describe a need → ranked shortlist → optional full analysis | Required before the need form | Ranking is code: [`selectBestDealOnEvidence`](../src/domain/find-best-deal.ts) via [`AssistantFlow.tsx`](../src/components/AssistantFlow.tsx). Optional later hop: SERV `find_next_check` in [`find-next-check-orchestrator.ts`](../src/server/find-next-check-orchestrator.ts) |
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
| Check — listing extract (optional) | `check_guard`, `listing_extract` | Skipped when year, make, and model are already parsed. Otherwise runs only if `SERV_API_KEY` is set and the page text is non-empty ([`extract-listing.ts`](../src/server/check/extract-listing.ts)). Those calls count toward Check’s 2-request cap in [`run-check.ts`](../src/server/check/run-check.ts). |
| Check — shopper verdict | `verdict_decide` → TS clamp → `verdict_challenge` | When a SERV key is set and ordered gates do not withhold: [`runShopperVerdictServ`](../src/server/shopper-verdict-serv.ts) from [`run-check.ts`](../src/server/check/run-check.ts). Prices stay on `evaluateListingPrice` via [`price-badge.ts`](../src/domain/price-badge.ts). No committed Check response id is in the repo yet — the path is wired, not a published live trace. |
| Full report — shopper verdict | `verdict_decide` | Multipath + JSON `{ verdict, note }`. Wired in [`assemble.ts`](../src/server/assemble.ts) after ordered gates. |
| TS clamp | `resolveVerdictDecision` | [`src/domain/verdict-decide.ts`](../src/domain/verdict-decide.ts) + rails in [`verdict-guardrails.ts`](../src/domain/verdict-guardrails.ts) / gates in [`verdict-gates.ts`](../src/domain/verdict-gates.ts). Dollar amounts stay in TypeScript. Park-it and title-brand force `pass`. A VIN identity conflict **withholds** the verdict and skips SERV. |
| Independent second pass | `verdict_challenge` | [`src/server/agent-second-pass.ts`](../src/server/agent-second-pass.ts) → `runReportVerdictChallenge`. Full reports call it from [`assemble.ts`](../src/server/assemble.ts). Check calls it from [`shopper-verdict-serv.ts`](../src/server/shopper-verdict-serv.ts) only after a usable `verdict_decide`. A failed decide does not spend the second call. |
| Revisions (sample replay) | Live recorder only | Script: `npm run eval:record-serv-revision` ([`eval/record-serv-revision.ts`](../eval/record-serv-revision.ts)). Output path: `fixtures/serv/recordings/verdict-revision.latest.json`. **Not yet recorded** on `main` — sample page shows “Example not yet recorded” ([`sample-report.ts`](../src/server/sample-report.ts), [`serv-revision-recording.ts`](../src/server/serv-revision-recording.ts)). |

### Visible decision trail

UI: [`AgentDecisionTrail`](../src/components/AgentDecisionTrail.tsx) (“How the agent decided”). Schema: [`docs/agent-verdict-schema.json`](agent-verdict-schema.json) ↔ [`src/domain/agent-verdict-schema.ts`](../src/domain/agent-verdict-schema.ts).

- Full reports: trail from `buildAgentVerdictFromReport` ([`agent-trail.ts`](../src/domain/agent-trail.ts)) using real decide/challenge outcomes when `SERV_API_KEY` is set.
- Check with a SERV key and gates that allow a verdict: the trail’s “why” is the model note from that run. `servTrace` on the Check result stores model, timestamp, OpenServ response id, and raw text ([`CheckFlow.tsx`](../src/components/CheckFlow.tsx)). There is no saved Check recording in the repo to cite.
- Check when decide fails: the panel says **Agent step unavailable — price rules only.** Trail steps stay empty. Price figures remain the code screening result.
- Check with no SERV key, or when gates withhold (for example a VIN dossier with no asking price): `no_serv_step: true` and no SERV spend ([`build-check-agent-verdict.ts`](../src/domain/build-check-agent-verdict.ts), [`shopper-verdict-serv.ts`](../src/server/shopper-verdict-serv.ts)).
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
| [`eval/results/latest.md`](../eval/results/latest.md) / [`latest.json`](../eval/results/latest.json) | Committed `eval:serv` comparison. Generated **2026-11-06T09:35:38.636Z**. 44 pairs. Checked answer **better on 2, worse on 3, both passed 39**. That is not a superiority result. Token usage and $0.1024 mini-rate **estimate** (not an invoice) are in that file. |
| [`eval/results/verdict-latest.md`](../eval/results/verdict-latest.md) | Status: **not yet run** (2026-11-06T13:44:21.845Z). No fabricated accuracy %. |
| Sample `/report/sample` agent revision | **Not yet recorded** — needs `npm run eval:record-serv-revision` (costs real SERV credits). |
| Lemonless vs plain-AI comparison scoreboard | Harness is on `main` ([`docs/eval/comparison.md`](eval/comparison.md), [`eval/results/comparison-latest.json`](../eval/results/comparison-latest.json)). That file is fixture mode, generated **2026-11-09T22:06:52.911Z**, `hasLiveScores: false`, `totals: null`, `scores: []`, `plain_llm` **not_run**. **No live scoreboard yet.** |

---

## Honest limitations

| Limitation | Evidence |
| --- | --- |
| Listing **link** mode can fail when sites block fetch (`listing_fetch_blocked`, paste/VIN alternatives) | [`run-check.ts`](../src/server/check/run-check.ts) |
| Recalls are model-year NHTSA coverage, not VIN repair proof; paid history (Carfax/NMVTIS) not connected | Check unknowns / report `dataNotes`; judge guide |
| Check SERV path is wired, but no Check response id is committed. A missing key or a failed decide does not invent a trail | [`shopper-verdict-serv.ts`](../src/server/shopper-verdict-serv.ts); UI copy in [`AgentDecisionTrail.tsx`](../src/components/AgentDecisionTrail.tsx) |
| Close-call **multipath** on Find is code reconciliation (`source: "code"` in `reconcileMultipathDeterministic`) unless the caller passes a live multipath result | [`agent-multipath.ts`](../src/domain/agent-multipath.ts), [`build-find-agent-verdict.ts`](../src/domain/build-find-agent-verdict.ts) |
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
