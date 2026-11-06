# AutoFlip: judge guide

## The product

AutoFlip helps a US used-car shopper decide whether one listing is worth pursuing. It compares asking prices and mileage, applies disclosed history adjustments, checks public government data, and returns a verdict with its arithmetic. Deal Radar applies the same idea to saved searches; Flip mode estimates a resale range from comparable asking prices, not completed sales.

Live product: [AutoFlip preview](https://autoflip-umber.vercel.app/). The sample report is explicitly labeled: [open sample](https://autoflip-umber.vercel.app/report/sample).

## The architecture in one picture

```text
Listing / VIN / shopper note
          |
          v
Local input screen + SERV prompt guard
          |
          v
Auto.dev + NHTSA + fueleconomy.gov + Census
          |
          v
Deterministic TypeScript engine
  - comparable selection
  - mileage and history adjustments
  - fair value / price gap / verdict
  - flip math and risk flags
          |
          v
Typed ComputedReport + facts snapshot
          |
          +----> SERV rules / explanation profiles
          |        - may interpret and explain facts
          |        - may not author or replace numeric facts
          |
          v
Number audit + deterministic fallback
          |
          v
Shopper report + Proof of AI
```

The key boundary is visible in code: buildComputedReport() produces a ComputedReport in [src/domain/report.ts](../src/domain/report.ts), whose shape is declared in [src/domain/types.ts](../src/domain/types.ts). assembleReport() in [src/server/assemble.ts](../src/server/assemble.ts) serializes selected computed facts into SERV requests, checks the model's wording against those facts, and keeps the deterministic result if the explanation fails. The shared [runServ() gateway](../src/server/serv/run.ts) is the only inference transport. Its input facts are typed as read-only ServFacts, while the result exposes explanation text and proof metadata rather than a replacement ComputedReport. That keeps the model response outside the numeric decision object.

## What OpenServ does

| Product moment | Profile(s) | Role |
| --- | --- | --- |
| Find a car | need_guard, need_extract | Screen the shopper's note and optionally extract a strict structured need; code validates the result. |
| Check a listing | check_guard, check_rules | Screen input, then interpret VIN/listing rules against government and listing facts. |
| Explain a full report | report_guard, report_explain | Screen the request and explain an already-computed report; the figure-reading tool makes the model read the supplied facts. |
| Agent API | agent_guard, agent_explain | Same controlled report flow for paid agent requests. |
| Deal Radar | radar_guard, personal_alert_review | Screen saved-search text and write a short relevance explanation; matching and price changes are calculated by code. |
| Flip Radar | flip_feasibility, flip_judge | Interpret flip rules and choose alert/skip after code computes the estimate and comparable count. |
| Telegram | telegram_reply | Screen and draft a limited help/connect reply. |

Profile definitions and the exact model features/tools are in [profiles.ts](../src/server/serv/profiles.ts). Kronos and Multipath are model suffixes/routing features, not independent agents coordinating a shared plan. Shadow Agent is a configured second pass, not evidence of a multi-agent swarm. We describe the system as profile-routed reasoning with an auditable record.

## Proof of AI: what is recorded

[proof.ts](../src/server/serv/proof.ts) records, when actually exposed by the response:

- requested and reported model, endpoint, latency, reasoning effort, and token usage;
- profile purpose, enabled tools, Kronos/Multipath suffixes, JSON schema and application-tool metadata;
- prompt-guard result, Shadow Agent outcome and iteration cap;
- whether a fallback was used and which numeric fields were computed by code.

The shopper-facing explanation in [decision-note.ts](../src/domain/decision-note.ts) is assembled from these recorded flags; it is not a separate model-generated claim about what happened. Agent report responses include a proof object. For a real trace, run a report with SERV configured and inspect that response; do not treat planned/skipped profile metadata as a completed inference call.

## How AutoFlip fits the Open Track

The official [SERV Hackathon Edition 01 page](https://www.openserv.ai/hackathon) defined the Open Track broadly: an agent, workflow, or product that leverages SERV Reasoning. The page listed creativity, user-readiness, and revenue potential as the judging criteria. Robinhood Mainnet/MCP, Coinbase AgentKit, and IXS RWA Vaults were separate partner tracks. **Open Track did not require an onchain wallet, x402 payments, or a multi-agent swarm.**

AutoFlip is best presented as a consumer decision product with an agent-facing interface—not as an autonomous onchain economy.

| Criterion | What AutoFlip can demonstrate | Honest qualification |
| --- | --- | --- |
| Creativity | One workflow supports both personal purchase decisions and resale screening; the same calculated evidence is exposed to shoppers and agents. SERV screens untrusted text, extracts structured needs, interprets procedural rules, reviews Radar signals, and selects Flip alert/skip outcomes. | Used-car valuation is an established category. The differentiator is the bounded, evidence-linked workflow—not the claim that the category itself is new. |
| User readiness | A working preview, labeled sample report, report-credit flow, Deal Radar, and agent API are implemented. | This remains an evaluation preview. Stripe is test mode; Auto.dev free-plan usage is evaluation-only; no licensed full title/service-history provider is connected; browser identity is anonymous. |
| Revenue potential | One-credit full reports, paid Radar plans, and agent API access provide plausible monetization paths. An optional x402 payment path exists in code. | Test-mode checkout and an optional payment adapter are not proof of live revenue or a settled x402 transaction. Do not claim traction or live payments without receipts. |

### Comparison with Edition 01 winners

ASSAY was the Best Overall Build and Open Track winner. OpenServ describes it as auditing Robinhood Chain stock-token valuations against raw onchain data, with SERV deciding whether a finding matters to the agent's mandate. SERVPIT received an Open Track honorable mention: six wallet-owning agents reason about whether to enter, stake, or borrow. Those projects made their specific decisions and consequences unusually visible.

AutoFlip is not equivalent to SERVPIT: it does not claim autonomous agents with independent wallets. It is closer to a bounded reasoning product: deterministic code owns vehicle facts and numeric decisions, while SERV handles guarded interpretation and selected structured judgments. The useful comparison is architectural, not a claim of equal autonomy or onchain scope.

Payrun is a useful secondary reference for the separation of responsibilities—SERV reasons within deterministic policy limits and a separate execution layer acts—but it won the Coinbase AgentKit partner track, not the Open Track.

### What would make the submission stronger

1. Run the fixed `eval:serv` suite with the real SERV key, inspect the failures as well as the wins, and commit the resulting `latest.md` and `latest.json`. Until then, the comparison dashboard is intentionally empty and there is no measured claim that SERV beats the baseline.
2. Show one real, redacted report/API proof trace that demonstrates which profile ran, what was actually returned by SERV, and which numeric fields remained code-computed. Do not substitute a planned profile or the static sample report for a live trace.
3. In a short demo, make the `flip_judge` alert/skip decision and the input-guard / need-extraction path visible. Those are easier to recognize as reasoning work than a generic explanation paragraph.

## Agent commerce: credits and optional x402

The agent API supports two separate payment paths. API-key requests spend one account credit after the report has been assembled. Without an API key, the optional x402 rail can accept a payment payload when `X402_PAY_TO`, `X402_NETWORK`, and `X402_ASSET` are configured. The scheme defaults to `gokite-aa`; the facilitator defaults to Pieverse. The rail is implemented in [x402.ts](../src/io/x402.ts), exposed through [the HTTP report endpoint](../src/app/api/v1/report/route.ts) and MCP [full_report](../src/app/api/mcp/route.ts).

The payment lifecycle now separates verification from settlement: the facilitator verifies the payment first, AutoFlip builds the report, and settlement is attempted only after report generation succeeds. This avoids charging for malformed requests or failed analysis. A configured endpoint is not evidence of live usage; only a successful settlement response and transaction hash prove that a payment occurred. No live payment was performed as part of this code review.

## Evaluation: executable, not yet published

Run npm run eval:serv with SERV_API_KEY set. The script in [eval/run.ts](../eval/run.ts) compares a plain base-model answer with the profile-enabled answer on fixed cases in [eval-cases.ts](../src/domain/eval-cases.ts). It scores prompt-injection following, invented numbers, schema validity, and consistency with supplied facts. It records actual API token usage and writes eval/results/latest.json and latest.md.

**Current evidence status:** the repository does not yet contain a generated result file. The evaluation runner is present, but we do not claim that SERV outperforms the baseline until the run is executed and its output reviewed and committed. Synthetic adversarial cases are labeled as synthetic by the test data.

## Product readiness and business model

- A full report costs one credit; Deal Radar search monitoring is free. The same report logic is exposed through MCP and a paid agent API.
- Stripe is intentionally in test mode. This demonstrates checkout and credit mechanics, not live revenue or a production payment operation.
- Auto.dev's free plan is an evaluation source, not a production license. No complete title-brand, theft, flood, or service-history database is connected.
- The app uses the `Kv` adapter: Upstash Redis when `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are set, a local JSON file for local development, and an in-memory fallback on Vercel if Redis is not configured. The connected Vercel project currently has those Upstash variables in Preview and Production, so user state is persisted rather than written to `/tmp`. This does not make the product launch-ready: the user ID is an anonymous browser cookie (no sign-in or cross-device recovery), and backup/monitoring plus high-concurrency write hardening still need attention.
- Asking-price comparables are not completed sale prices. Public recalls are not a VIN-specific repair confirmation.

The CI quality gate runs typecheck, the unit suite and npm audit, and blocks critical/high dependency advisories. The current lockfile was refreshed to Vitest 5.1.0 and PostCSS 8.5.32; the lockfile refresh run reported zero advisories. These constraints are also documented in the main [README](../README.md); they are disclosed rather than hidden behind a polished demo.
