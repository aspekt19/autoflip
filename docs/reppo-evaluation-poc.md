# Reppo Evaluation API — isolated proof of concept

Status: experimental, not connected to shopper or agent report flows.

## Why this experiment exists

AutoFlip already has three distinct responsibilities:

1. TypeScript computes vehicle facts, comparables, prices, margins, and verdicts.
2. SERV reasons over untrusted listing context and explains the computed result.
3. A local deterministic audit rejects explanations that introduce unsupported numbers.

Reppo is being evaluated only as an independent quality signal for the *written explanation*. It must not recalculate vehicle values, replace the deterministic verdict, or be treated as proof that a car's market value is correct.

## Provider contract confirmed from Reppo's public Evaluation API page

- Submit: `POST https://eval.reppo.xyz/api/v1/agents/eval-requests/submit`
- Read: `GET https://eval.reppo.xyz/api/v1/agents/eval-requests/{evalId}`
- Auth: `Authorization: Bearer YOUR_API_KEY`
- Types: `answer | plan | trace | artifact`
- Payload: text, up to 50 KB; optional free-form context.
- Settlement windows: 10, 15, or 30 minutes.
- Documented verdict fields include score (0–100), decision (Accept / Revise / Reject), confidence, dimension critiques, evidence basis, peer assessment count and contributor/assessment details.
- Public launch pricing: 10 evaluations free, then introductory $0.01 per evaluation.

Provider documentation: https://reppofoundation.org/evaluation-api

## What is implemented

`src/server/reppo/client.ts` contains a server-side-only transport wrapper for submit and retrieve. It accepts an API key as an explicit argument, never reads it in client code, enforces the documented payload size, and leaves the provider response untrusted/raw for a later schema-validation step.

This is intentionally not imported by `assembleReport`, API routes, Radar, or the browser. No report is gated by Reppo. The isolated branch does not change production behaviour.

## Proposed experiment

For a small, labeled sample of SERV `report_explain` outputs, submit a `trace` with:

- **payload:** the SERV explanation plus a compact representation of the decision and explanation provenance;
- **context:** the exact computed facts, which values are estimates, the original task, and explicit evaluation criteria.

Evaluate whether the explanation:
1. stays within the supplied vehicle facts;
2. distinguishes sourced facts from estimates and seller claims;
3. states material uncertainty and missing checks;
4. explains the deterministic verdict without contradicting it.

The exact computed facts must be included in context, but must not be exposed as if they were independently verified by Reppo. No VIN, user identifier, API credential, raw private listing text, or customer report should be sent in the initial experiment. Use synthetic fixtures and redact identifiers.

## Critical validity risk

Reppo's public description says peer judges ground assessments in evidence from Reppo's network and may decline to produce an evaluation when no relevant evidence is found. AutoFlip's synthetic used-car fixtures may have no matching Reppo evidence. A denial / insufficient-evidence result is not a failed SERV explanation and must not be counted as a Reppo rejection.

The experiment must record separately:
- evaluation settled with a usable verdict;
- evaluation pending / timeout;
- denied or insufficient evidence;
- provider/API error.

Do not interpret an evidence-free model judgment as an independent evidence-backed verdict.

## Decision gate

Integrate only if the test demonstrates all of the following:

- Reppo settles a meaningful share of relevant AutoFlip cases with usable, evidence-backed verdicts;
- it catches at least one material explanation defect missed by the existing deterministic audit;
- false-positive revise/reject decisions on clean explanations remain acceptably low after manual review;
- added latency and cost are acceptable for the product.

Until those conditions are measured, Reppo remains an offline evaluation experiment, not a production dependency or customer-facing badge.
