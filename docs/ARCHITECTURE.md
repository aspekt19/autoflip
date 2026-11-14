# Lemonless architecture

Lemonless combines OpenServ SERV reasoning, live vehicle inventory, public vehicle-data sources, deterministic automotive calculations, and an auditable decision record.

**Live application:** https://autoflip-umber.vercel.app/  
**Proof of AI:** https://autoflip-umber.vercel.app/proof  
**SERV runtime:** https://autoflip-umber.vercel.app/where-serv-runs

For implementation detail, start with [SERV architecture](SERV_ARCHITECTURE.md) and the [application tool catalog](TOOL_CATALOG.md).

## System layers

| Layer | Responsibility | Key implementation |
|---|---|---|
| Product UI and routes | Shopper conversations, brief confirmation, reports, Radar, account and admin surfaces. | src/app/ |
| Agent orchestration | Stateful Find and Resale loops, tool rounds, checkpoint restore, terminal decisions. | src/server/find-agent/, src/server/resale-agent/ |
| SERV runtime | Profiles, model resolution, reasoning features, HTTP transport, Responses protocol and Proof. | src/server/serv/ |
| Application tools | Inventory queries, VIN/evidence lookups, local comps and P&L. | src/server/find-agent/tools.ts, src/server/resale-agent/tools.ts |
| Domain rules | Vehicle normalization, distance, price, offer, P&L, verdict and guardrail calculations. | src/domain/ |
| Persistence | Shared sessions, credits, watches, alerts, checkpoints, and idempotency state. | src/io/ |
| External agent interface | MCP JSON-RPC, REST endpoints, keys/scopes, receipts and x402 payments. | src/app/api/mcp/, src/app/api/v1/, src/server/ |

## Find flow

A shopper describes the car they need in natural language. The Find conversation is handled by src/server/find-chat.ts and src/server/find-agent/loop.ts.

1. **Intake:** SERV interprets the request and asks for missing facts when needed.
2. **Structured brief:** SERV submits budget, ZIP, radius, notes and hard/soft constraints. The budget quote is tied to the shopper's actual message.
3. **Confirmation:** the shopper confirms or corrects the brief. Search tools stay unavailable until confirmation.
4. **Inventory:** SERV selects search_listings calls and decides which relaxable search directions to try. Auto.dev results include provider rows, pagination, duplicate-search signals and a filter funnel.
5. **Evidence:** SERV can request recalls/complaints, safety ratings, VIN decode, fuel economy and market comps for finalists.
6. **Terminal decision:** SERV submits submit_picks or submit_nothing_fits.
7. **Validation and delivery:** code validates candidate VINs, evidence IDs, budget, radius, structured offer, and applicable title/history constraints; then the result and journal are persisted.

The SERV profile policy, tool protocol, and checkpoint design are described in [SERV architecture](SERV_ARCHITECTURE.md).

## Deterministic decision layer

The model receives facts that have already been calculated by Lemonless. The code layer owns:

- VIN normalization and source provenance across inventory, listing page, vPIC, fuel, NHTSA and other available sources.
- Distance calculation from feed miles, coordinates, ZIP lookup, or the bundled ZIP centroid table. A value that cannot be calculated remains unverified.
- Fair-value and local asking-price context, based on available comparable listings.
- Structured opening-offer and walk-away fields.
- Resale acquisition-to-exit P&L, including fees, tax, title, reconditioning assumptions, expected resale and profit.
- Final allowlists and hard constraints on VINs, evidence IDs, budget, radius, title/history, and permitted actions.

The final action is selected by SERV from the supplied facts. The application validates the selection before publication. Resale buy/negotiation requires positive code-computed mid-profit.

## Check

Check is implemented by src/server/check/run-check.ts. It extracts and normalizes the submitted VIN/listing, gathers available vehicle and market evidence, calculates the financial context, then uses the relevant SERV profiles to review the facts and produce a shopper-facing report. The report explanation reads the exact computed figures through the read_computed_facts application tool.

## Resale

Resale follows the same agent pattern as Find with a profit-first objective. SERV creates a confirmed budget/criteria brief, directs inventory searches, chooses which finalists deserve checks, and selects a candidate from a code-computed P&L sheet. get_flip_pnl returns the calculated economics to the agent. The terminal validation enforces the mid-profit rule.

## Deal Radar

Deal Radar persists saved Find/Resale watches, seen VIN/price state, run history, alerts, SERV checks, and decision-proof records. The Vercel schedule in vercel.json starts the daily cycle at 14:00 UTC. The listing cache in src/server/radar-store.ts has a three-hour TTL. SERV reviews eligible new or changed candidates after the code layer has prepared the relevant vehicle and P&L facts.

The deployed Vercel test mode is globally bounded to one watch and one notification. A successful first test alert, or the three-cycle ceiling, pauses new checks across scheduled and manual entry points. An administrator can re-arm the test; setting RADAR_TEST_MODE=0 selects normal Radar operation.

## Decision journals and Proof of AI

The application records separate SERV and application-tool activity. Decision-proof records include profile names, requested/reported model IDs, features, tool names, response IDs, status, latency, available usage, structured output, code-computed facts, evidence IDs, and final decisions.

The public [Proof page](https://autoflip-umber.vercel.app/proof) presents the recorded Denver Find run and its Gemini comparison. The redacted SERV trace harness stores execution metadata without persisting raw prompts, VINs, source facts, or free-form model output.

## External agent architecture

The external agent layer exposes the same product logic through MCP and REST.

- MCP: POST /api/mcp, JSON-RPC over HTTP POST, protocol 2025-06-18.
- REST: /api/v1/check, /api/v1/find, /api/v1/resale, /api/v1/radar/*, /api/v1/report and receipt routes.
- Authentication: af_ API keys bound to verified account owners, scoped as read/check/find, with per-key rate limits.
- Payments: x402 v2 exact USDC on Base for registration, direct reports, report-credit packs and prepaid Radar plans.
- Delivery: async Find/Resale run IDs, status/result polling, idempotency keys and structured proof records.

The full interface is documented in [TOOL_CATALOG.md](TOOL_CATALOG.md), with MCP authentication in [OPENSERV_MCP_AUTH.md](agents/OPENSERV_MCP_AUTH.md).

## Persistence and runtime

Vercel production uses Upstash Redis REST for shared state. The KV layer exposes atomic operations, including INCR, SET NX and compare-and-swap. Spend-sensitive and Radar safety paths fail closed if shared persistence cannot be verified. Local development uses the file-backed KV adapter when Upstash is not configured.

Find/Resale run checkpoints and idempotency records support multi-request execution. Credit reservations are settled only at qualifying result delivery. The verified administrator allowlist is supplied through LEMONLESS_ADMIN_EMAILS; administrator-granted extra Find/Resale sessions are recorded separately from administrator privileges.

## Current operating configuration

- Stripe human checkout is in Test Mode.
- x402 agent payments use USDC on Base Mainnet when CDP facilitator credentials are configured.
- Deal Radar uses the bounded one-notification test mode on Vercel unless RADAR_TEST_MODE is set to 0.
- The default SERV model is gpt-6.1-sol, with model/profile overrides controlled by the profile allowlist.

