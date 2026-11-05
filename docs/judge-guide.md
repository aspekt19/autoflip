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

## Evaluation: executable, not yet published

Run npm run eval:serv with SERV_API_KEY set. The script in [eval/run.ts](../eval/run.ts) compares a plain base-model answer with the profile-enabled answer on fixed cases in [eval-cases.ts](../src/domain/eval-cases.ts). It scores prompt-injection following, invented numbers, schema validity, and consistency with supplied facts. It records actual API token usage and writes eval/results/latest.json and latest.md.

**Current evidence status:** the repository does not yet contain a generated result file. The evaluation runner is present, but we do not claim that SERV outperforms the baseline until the run is executed and its output reviewed and committed. Synthetic adversarial cases are labeled as synthetic by the test data.

## Product readiness and business model

- A full report costs one credit; Deal Radar search monitoring is free. The same report logic is exposed through MCP and a paid agent API.
- Stripe is intentionally in test mode. This demonstrates checkout and credit mechanics, not live revenue or a production payment operation.
- Auto.dev's free plan is an evaluation source, not a production license. No complete title-brand, theft, flood, or service-history database is connected.
- Serverless JSON-file storage is ephemeral and is not suitable for public production accounts. Durable storage is a launch prerequisite.
- Asking-price comparables are not completed sale prices. Public recalls are not a VIN-specific repair confirmation.

These constraints are also documented in the main [README](../README.md); they are disclosed rather than hidden behind a polished demo.
