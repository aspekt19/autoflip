# Lemonless application tool catalog

This document describes the function tools exposed to OpenServ SERV and the external-agent MCP tools exposed by Lemonless. SERV chooses a named application function; Lemonless validates and executes it.

## 1. Tool execution contract

An application tool definition contains a name, description, and JSON Schema. The schema is sent to SERV as part of the Responses tool list. When SERV returns a function call:

1. Lemonless reads the function name, arguments, and call ID.
2. The active product loop validates the tool name and argument structure.
3. The server verifies the tool is allowed in the current phase. For example, inventory search is unavailable before shopper brief confirmation.
4. TypeScript executes the provider request or deterministic calculation.
5. The application records the call, arguments, result, and source evidence in the decision journal.
6. The result is returned to SERV under the matching function-call ID.

Only tools registered by the active product agent can be executed. Tool execution is server-side; the model selects a function but does not execute provider requests itself.

## 2. Find application tools

Implementation: **src/server/find-agent/tools.ts**.

| Tool | Input contract | Execution and result |
|---|---|---|
| **ask_shopper** | One natural-language question. | Stores a pending question and pauses the run until the shopper replies. |
| **record_shopper_facts** | budgetUsd, ZIP, and radiusMi. | Records shopper-stated budget and location facts as structured context for downstream checks. |
| **submit_brief** | Summary, budget amount and verbatim budget quote, ZIP, radius, notes, hard/soft constraints, and agreed relaxations. | Submits the brief for shopper confirmation. Inventory tools remain gated until the brief is confirmed. |
| **search_listings** | Make/model, body family, price ceiling, mileage ceiling, year bounds, ZIP, radius, transmission, fuel, drivetrain, sort, page, and limit. | Calls Auto.dev inventory and returns provider listing rows, pagination state, duplicate-search indication, constraint roles, and an observational filter funnel. |
| **get_recalls_complaints** | Make, model, year. | Retrieves NHTSA recall-campaign and complaint context for the vehicle configuration. It is not a VIN-specific open-recall status lookup. |
| **get_safety_ratings** | Make, model, year. | Retrieves available NHTSA / NCAP safety-star information. |
| **get_vin_decode** | A batch of finalist VINs (up to 20). | Calls NHTSA vPIC to decode vehicle identity and compare it with the listing. |
| **get_fuel_economy** | A batch of finalist VINs (up to 20). | Uses listing year/make/model identity to retrieve FuelEconomy.gov ratings and estimated fuel-cost context. |
| **get_market_comps** | Make/model, year range, price ceiling, ZIP, radius, and limit. | Uses listings already collected or a narrow fresh search to compute local asking-price context. |
| **submit_picks** | Structured Find terminal-result schema. | Submits selected VINs, action, evidence-backed reasons, opening offer, and walk-away value. The server validates VIN provenance, action, offer/budget constraints, known radius, and explicit title/history constraints. |
| **submit_nothing_fits** | Overall explanation and candidate-specific rejection rows containing exact VINs. | Finishes with an evidence-backed no-fit result and the reason each real candidate was rejected. |

### Find tool behavior

- **Brief confirmation is a hard gate.** Search tools cannot execute before the shopper confirms the submitted brief.
- **SERV chooses search directions.** search_listings returns the provider rows plus a diagnostic funnel and hard/relaxable constraint roles. The application does not silently relax filters.
- **Pagination is explicit.** The tool reports whether results are truncated and accepts page numbers so SERV can request additional provider pages.
- **Duplicate requests are visible.** Repeating identical filters is recorded; the model can change a relaxable filter instead of sending the same query repeatedly.
- **Evidence tools are batched.** VIN decode and fuel-economy tools can process finalist VIN sets.
- **Terminal recommendations are validated.** A selected VIN must have been returned by inventory tools. Code checks the structured offer against the confirmed budget and known asking price and checks known distance against the confirmed radius.
- **No-fit is a first-class result.** When none of the actual listings meet the brief, submit_nothing_fits preserves the candidates and their rejection reasons.

## 3. Resale application tools

Implementation: **src/server/resale-agent/tools.ts**. Resale shares the shopper-intake, inventory, and vehicle-evidence tool set, with Resale-specific brief and terminal schemas.

| Tool | Input contract | Execution and result |
|---|---|---|
| **ask_shopper** | One clarifying question. | Pauses Resale for the shopper's reply. |
| **record_shopper_facts** | Budget, ZIP, radius. | Stores the shopper-stated facts used by the flip search. |
| **submit_brief** | Budget and verbatim budget quote, ZIP/radius, budget-only flag, explicit hard constraints, and risk notes. | Creates the Resale Confirm/Correct brief before searching inventory. |
| **search_listings** | Shared inventory query fields. | Calls Auto.dev and journals returned listings. Budget-only mode allows a broad initial inventory search. |
| **get_recalls_complaints** | Make/model/year. | Retrieves NHTSA recall/complaint context for a candidate. |
| **get_safety_ratings** | Make/model/year. | Retrieves available NHTSA / NCAP safety ratings. |
| **get_vin_decode** | Batch of finalist VINs. | Calls NHTSA vPIC for identity validation. |
| **get_fuel_economy** | Batch of finalist VINs. | Looks up FuelEconomy.gov fuel-economy estimates. |
| **get_market_comps** | Model and market filters. | Computes local asking-price context from comparable active listings. |
| **get_flip_pnl** | VINs already returned by inventory search. | Returns code-computed purchase-to-resale economics: offer scenario, fees/tax, title fee, estimated reconditioning, expected resale, and profit. |
| **submit_picks** | Structured Resale terminal-result schema. | Submits candidate VINs and evidence-backed rationale. Buy/negotiation is accepted only when code-computed mid-profit is positive and the VIN/offer are valid. |
| **submit_nothing_fits** | Overall no-fit reason. | Finishes with a reasoned no-fit result and the real search journal. |

The model does not calculate flip dollars in prose. It receives TypeScript-computed P&L and uses those figures in its selection and explanation. A buy/negotiation recommendation cannot bypass the code profit rule.

## 4. Code-computed work behind the tools

| Calculation/check | Owner | Role in the decision |
|---|---|---|
| Listing identity and normalized vehicle record | Lemonless TypeScript | Merges provider, page, VIN, and public-record fields by VIN while preserving source provenance. |
| VIN validation and vPIC consistency | Lemonless TypeScript + NHTSA vPIC | Confirms the candidate identity against the listing record. |
| Distance from buyer ZIP | Lemonless TypeScript | Uses provider distance, listing coordinates, ZIP lookup, or ZIP-centroid data when available; unknown remains unverified. |
| Local price context | Lemonless TypeScript | Computes market context from active asking-price listings. |
| Structured offer | Lemonless TypeScript validation + SERV selection | Opening offer and walk-away are explicit fields, validated and rendered by the application. |
| Resale economics | Lemonless TypeScript | Calculates taxes, fees, title fee, estimated reconditioning, expected resale, and mid-profit. |
| Hard constraints | Lemonless TypeScript | Checks exact VIN allowlists, confirmed budget/radius, known title/history flags, and permitted actions. |
| Evidence trail | Lemonless decision journal | Captures provider tool calls, source results, SERV decisions, and evidence IDs. |

## 5. Deal Radar reviews

Deal Radar reuses the same inventory and evidence layer but is driven by saved watches and scheduled/manual review cycles.

- **radar_guard** screens saved-search criteria before a cycle.
- Personal/Drive-it candidates use code-computed vehicle facts and the shopper verdict/challenge profiles.
- Resale/Flip candidates use code-computed P&L and the radar_review profile to choose alert or skip.
- Seen VIN/price state is stored by search criteria so repeated listings are not reviewed as new candidates.
- The daily schedule is declared in vercel.json at 14:00 UTC.
- The bounded Vercel test mode allows one project-wide watch and one notification, and stops new monitoring after the first alert or the three-cycle ceiling. An administrator can re-arm the test; RADAR_TEST_MODE=0 selects normal Radar operation.

Radar stores run history, provider-call counts, SERV checks, decisions, alerts, and decision-proof records.

## 6. MCP tool catalog

The MCP server is **POST /api/mcp**. It implements JSON-RPC over HTTP POST with initialize, ping, tools/list, and tools/call.

| MCP tool | Purpose | Required scope |
|---|---|---|
| **get_payment_info** | Public onboarding and payment instructions. | Public; no API key. |
| **check_car** | Runs the same Check pipeline as the website. | check |
| **find_cars** | Starts an asynchronous Find run and returns run_id. | find |
| **find_cars_status** | Polls Find progress. | find |
| **find_cars_result** | Advances if necessary and returns the completed Find result. | find |
| **resale_search** | Starts an asynchronous Resale job. | find |
| **resale_status** | Polls Resale progress and journal. | find |
| **resale_result** | Advances if necessary and returns the Resale result. | find |
| **deal_radar** | Direct one-off Radar scan when allowed by the global test-mode gate. | read |
| **radar_watches** | Lists saved watches for the API-key owner. | read |
| **radar_save_watch** | Saves a Find/Resale watch. Requires an active Radar plan. | read |
| **radar_check_now** | Runs enabled watches now when allowed by the global test-mode gate. | read |
| **radar_feed** | Lists recent alerts. | read |
| **full_report** | Generates a full VIN-scoped Personal or Flip report. | check |

### MCP response structure

Responses include content for general MCP clients and structuredContent for machine-readable consumers. Start requests return a run/job ID and a next_steps polling instruction. Result payloads include structured verdicts and decision-proof/journal records.

## 7. REST API map

Agent REST endpoints use Authorization: Bearer af_… and the appropriate key scope.

| Route | Method | Purpose |
|---|---|---|
| /api/agents/register | POST | x402-paid registration and one-time API-key issuance. |
| /api/agents/keys | GET/POST/DELETE | Manage an account's agent keys. |
| /api/agents/payment-info | GET | Payment readiness and instructions. |
| /api/agents/billing/credits | POST | Buy a report-credit pack using x402. |
| /api/agents/billing/plans | POST | Buy a prepaid Radar plan using x402. |
| /api/v1/check | POST | Run a Check. |
| /api/v1/find | POST | Start Find; returns HTTP 202 and a run ID. |
| /api/v1/find/:runId/status | GET | Poll Find progress. |
| /api/v1/find/:runId | GET | Retrieve the Find result. |
| /api/v1/resale | POST | Start Resale; returns a job ID. |
| /api/v1/resale/:jobId/status | GET | Poll Resale progress. |
| /api/v1/resale/:jobId | GET | Retrieve the Resale result. |
| /api/v1/radar/watches | GET/POST | List or save Radar watches. |
| /api/v1/radar/check | POST | Check enabled watches now, when allowed. |
| /api/v1/radar/feed | GET | Retrieve recent Radar alerts. |
| /api/v1/report | POST | Directly purchase and run a full report through x402. |
| /api/v1/receipts | GET | List payment and delivery receipts. |
| /api/v1/receipts/:receiptId | GET | Inspect one receipt. |

## 8. Authentication, ownership, and billing

- Agent keys use the af_ prefix and are bound to a verified account owner.
- Keys carry explicit read, check, and find scopes.
- Agent requests are rate-limited per key and return rate-limit headers.
- Find and Resale status/result routes verify that a run or job belongs to the authenticated API-key owner.
- Idempotency keys prevent duplicate starts and repeat deliveries for supported routes.
- Find and Resale use the shared search-billing gate. Credit reservation is committed when a qualifying result is delivered; pre-delivery failure follows the compensation policy.
- Radar watches require an active Radar plan. Radar plans and report credits are separate.

## 9. Where to inspect the code

- Find tools: **src/server/find-agent/tools.ts**.
- Resale tools and P&L: **src/server/resale-agent/tools.ts** and **src/domain/resale-pnl.ts**.
- Responses transport and call-ID protocol: **src/server/serv/agent-chat-turn.ts** and **src/server/serv/agent-tool-loop-protocol.ts**.
- Agent loops and journals: **src/server/find-agent/loop.ts** and **src/server/resale-agent/loop.ts**.
- MCP schemas and dispatch: **src/server/mcp.ts** and **src/app/api/mcp/route.ts**.
- Agent authentication and scopes: **src/server/agent-auth.ts** and **src/server/agent-scopes.ts**.
- Decision-proof contract: **src/domain/decision-proof-record.ts**.
