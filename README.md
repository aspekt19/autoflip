# Lemonless

**Lemonless is an OpenServ SERV-powered vehicle decision agent.** It turns a natural-language buyer brief into a validated search, gathers vehicle-level evidence, compares candidates, and returns a specific next action with an auditable decision trail.

[**Live application**](https://autoflip-umber.vercel.app/) · [**Proof of AI**](https://autoflip-umber.vercel.app/proof) · [**Where SERV runs**](https://autoflip-umber.vercel.app/where-serv-runs) · [**Agent API**](https://autoflip-umber.vercel.app/developers) · [**OpenAPI**](https://autoflip-umber.vercel.app/openapi.json)

[![CI](https://github.com/aspekt19/autoflip/actions/workflows/ci.yml/badge.svg)](https://github.com/aspekt19/autoflip/actions/workflows/ci.yml)

Built for **OpenServ SERV Hackathon Edition 02 — Open Track**.

---

## Start here

1. Open the [live application](https://autoflip-umber.vercel.app/) and visit **Find**.
2. Submit a natural-language request. SERV turns it into a structured brief; the shopper confirms the brief before inventory search begins.
3. Follow the live agent trail: SERV chooses search and evidence tools, reviews the returned candidates, and submits a terminal recommendation or a reasoned no-fit result.
4. Open [Proof of AI](https://autoflip-umber.vercel.app/proof) to inspect the recorded end-to-end Find case, including the exact listing, supporting evidence, offer, confidence, SERV/tool counts, and the Gemini comparison.
5. Open [Where SERV runs](https://autoflip-umber.vercel.app/where-serv-runs) for the runtime integration view, then inspect the implementation paths below.

The most important source files for reviewing the SERV integration are:

- \`src/server/serv/profiles.ts\` — the central registry of task-specific SERV profiles.
- \`src/server/serv/agent-serv-features.ts\` — per-step Prompt Guard, Kronos, Multipath, and Shadow Agent policy for Find and Resale.
- \`src/server/serv/agent-chat-turn.ts\` and \`src/server/serv/agent-tool-loop-protocol.ts\` — SERV Responses and multi-turn function-tool transport.
- \`src/server/find-agent/loop.ts\` and \`src/server/resale-agent/loop.ts\` — the agent loops that let SERV plan, call tools, and deliver a decision.
- \`src/server/find-agent/tools.ts\` and \`src/server/resale-agent/tools.ts\` — application-owned tools exposed to SERV.
- \`src/server/serv/proof.ts\` and \`src/domain/decision-proof-record.ts\` — the structured execution and evidence trail.

See [SERV architecture](docs/SERV_ARCHITECTURE.md) and the [tool catalog](docs/TOOL_CATALOG.md) for the full implementation map.

## What Lemonless does

| Product surface | What it does |
|---|---|
| **Find** | Converts a buyer's natural-language request into a confirmed brief, searches live dealer inventory, requests vehicle evidence, and returns a ranked shortlist with a specific recommendation and offer. |
| **Check** | Evaluates a VIN, listing URL, or pasted listing. Code computes the vehicle and price facts; SERV interprets the evidence and supports the decision. |
| **Resale** | Searches for purchase-to-resale opportunities. Code computes acquisition costs, fees, tax, reconditioning, expected resale, and risk-adjusted profit; SERV chooses how to act on the resulting candidates. |
| **Deal Radar** | Tracks saved Find or Resale criteria, checks for new or changed inventory, and creates alerts after the configured SERV review. Telegram can deliver an optional copy of an in-app alert. |

## Why SERV is central to the product

Lemonless separates agent reasoning from deterministic execution:

- **SERV reasons.** It interprets buyer intent, asks clarifying questions, proposes and confirms a structured brief, chooses application tools, reviews candidate evidence, decides which candidates deserve another look, and produces the final recommendation.
- **TypeScript executes and verifies.** It fetches inventory and public records, normalizes VIN data, calculates distance and price context, computes all financial figures, tracks source provenance, enforces hard constraints, validates model-selected VINs and evidence IDs, and commits credits only after successful delivery.
- **The application tools connect both sides.** SERV chooses a named function tool; Lemonless executes that tool against its own data providers and returns a structured result for the next SERV turn.

This is a working agent loop, not a one-shot prompt that asks a model to write a car-buying answer. The loop can span multiple SERV turns and tool rounds. Its state, prior Responses items, tool outputs, VIN map, P&L facts, pending shopper question, confirmed brief, and decision journal are serialized into a checkpoint so the run can continue across HTTP requests.

### Runtime flow

\`\`\`mermaid
flowchart TD
  A[Shopper describes the need] --> B[SERV interprets intent]
  B --> C{Need clarification?}
  C -->|Yes| D[ask_shopper]
  D --> A
  C -->|No| E[submit_brief]
  E --> F[Shopper confirms or corrects]
  F --> G[SERV selects application tools]
  G --> H[Auto.dev inventory and evidence lookups]
  H --> I[Structured tool results return to SERV]
  I --> J[SERV triages and evaluates candidates]
  J --> K{Terminal decision}
  K -->|Candidate recommendation| L[submit_picks]
  K -->|No suitable candidate| M[submit_nothing_fits]
  L --> N[TypeScript validation and decision journal]
  M --> N
  N --> O[Report, offer and Proof of AI]
\`\`\`

The model owns the decision path; code owns the data contract and the hard rules. The final recommendation is backed by the exact listings and evidence returned during that run.

## OpenServ SERV integration

The production integration uses the OpenAI-compatible SERV Reasoning API at \`SERV_BASE_URL\` (default \`https://inference-api.openserv.ai/v1\`) with \`SERV_API_KEY\`. The default model is \`gpt-6.1-sol\`, declared once as \`BASE_MODEL\` in \`src/server/serv/profiles.ts\`.

Lemonless maintains a task-specific profile registry instead of using one generic prompt for every operation. A profile defines its purpose, system instruction, model feature, endpoint, reasoning effort, output format, timeout, and code-computed facts.

### SERV features used by the implementation

| SERV capability | How Lemonless applies it |
|---|---|
| **Prompt Guard** | Adds the SERV input-gate marker to the first turn of an agent conversation and to protected one-shot lookups. User text and fetched listing content are treated as untrusted input. |
| **Kronos** | Adds a rules-audit/repair pass to selected planning and decision steps. Find's final agent selection uses the combined Kronos + Multipath model route. |
| **Multipath** | Adds alternative reasoning paths for decisions where comparing price, risk, or total cost from different angles is useful. Find's final selection uses Kronos + Multipath; Resale's final selection uses Multipath. |
| **Shadow Agent** | Adds a separate validation pass with a task-specific hint. Find and Resale use it on the dedicated final selection hop; the configured iteration ceiling is two. |
| **Strict JSON Schema** | Constrains machine-consumed plans and decisions to explicit fields and enums. Server code validates the returned values again before publishing them. |
| **Reasoning effort** | Profiles select supported low or medium effort. Agent steps set bounded output-token ceilings appropriate to intake, search, and verdict work. |
| **Prompt caching** | Uses SERV's default prompt-cache behavior with stable system instructions and variable shopper facts in the input. |
| **Content filter** | Leaves the SERV content filter enabled by default. |
| **Responses API reasoning state** | Agentic function-tool calls use \`/v1/responses\`; prior reasoning and function-call items are preserved with one result for every function-call ID on the next turn. |
| **Application tools** | Report explanation profiles can force \`read_computed_facts\`, returning the exact numbers computed by Lemonless for the explanation. |
| **Usage and Proof** | Captures response IDs, requested/reported model, profile, features, tool names, latency, status, usage when available, and decision-proof records. |

SERV's built-in markers and Lemonless application tools are intentionally distinct:

- \`serv_prompt_guard\` and \`serv_shadow_agent\` are SERV feature markers.
- \`search_listings\`, \`get_vin_decode\`, \`get_market_comps\`, and other named business functions are Lemonless application tools. They call application-owned providers and code.
- \`read_computed_facts\` is a Lemonless application tool used by the report-explanation profiles to read the already-computed fact set.

Find and Resale have a step policy: intake and search use the base model; the dedicated final selection hop enables the product-specific reasoning bundle. Prompt Guard is included on the first SERV call of the chat. This keeps the profile consistent with the actual role of each turn. The profile registry also defines the focused Check, report, and Radar steps.

The implementation and profile matrix are documented in [SERV architecture](docs/SERV_ARCHITECTURE.md). OpenServ's overview is available at [SERV Reasoning](https://www.openserv.ai/reasoning).

### Why the Responses tool protocol matters

For agentic Find and Resale, Lemonless uses SERV's Responses function tools. Each turn can contain reasoning items and one or more function calls. The next turn replays the original input prefix, preserves the relevant reasoning/function-call items, and appends a \`function_call_output\` for every \`call_id\`. Parallel calls are handled as a set; no function call is intentionally left without an output.

The Chat Completions path is used for profile-driven structured decisions and as a schema-only next-action path. Function tools are not attached to that fallback path for the production agent model. The transport rules are implemented in \`agent-chat-turn.ts\`, \`agent-tool-loop-protocol.ts\`, and the product loops.

### Production boundary

The product calls SERV through the dedicated HTTP transport layer in \`src/server/serv/\`. The OpenServ SDK is a development dependency for tooling; it is not part of the production dependency tree or the deployed Next.js server bundle. CI checks both the production dependency graph and the built \`.next/server\` output for this boundary.

## Application tools and data

The tool definitions are schemas presented to SERV. Their implementations are server-owned TypeScript functions. SERV chooses when to call them; the application validates arguments, executes the provider lookup or calculation, journals the result, and sends structured output back to SERV.

### Find tool set

| Tool | Purpose |
|---|---|
| \`ask_shopper\` | Pause the run with one clarifying question and wait for the shopper's reply. |
| \`record_shopper_facts\` | Store stated budget, ZIP, and radius as structured context for subsequent checks. |
| \`submit_brief\` | Submit the search brief for shopper confirmation before any inventory request. |
| \`search_listings\` | Query Auto.dev dealer inventory with explicit filters and pagination. Returns provider rows and a diagnostic funnel; SERV can choose a new search direction or a shopper-approved relaxation. |
| \`get_recalls_complaints\` | Retrieve NHTSA recall-campaign and complaint context for a make/model/year. |
| \`get_safety_ratings\` | Retrieve available NHTSA / NCAP safety ratings. |
| \`get_vin_decode\` | Batch-decode finalist VINs through NHTSA vPIC and compare the decoded identity with the listing. |
| \`get_fuel_economy\` | Batch-retrieve FuelEconomy.gov estimates for finalist configurations. |
| \`get_market_comps\` | Compare active asking prices for the same model in the requested area; produces a price context from asking-price listings. |
| \`submit_picks\` | Submit the terminal shortlist, selected VIN, action, evidence-backed reasons, opening offer, and walk-away price. |
| \`submit_nothing_fits\` | Submit a terminal no-fit result with candidate-specific rejection reasons. |

### Resale tool set

Resale shares the shopper-intake and inventory/evidence tools, with Resale-specific brief and terminal schemas. It adds:

- \`get_flip_pnl\` — calculates the candidate's acquisition-to-resale economics in TypeScript, including purchase price, negotiation scenario, taxes/fees, title fee, reconditioning, expected resale, and profit.
- Resale \`submit_brief\` — confirms a budget-first or constraint-specific flip-search brief.
- Resale \`submit_picks\` — publishes only candidates with a valid code-computed P&L and a supported action. A buy/negotiation action requires positive code-computed mid-profit.
- Resale \`submit_nothing_fits\` — explains why the current search did not produce a suitable flip.

### Data and validation

- **Auto.dev** supplies dealer inventory and asking-price listing data.
- **NHTSA vPIC** supports VIN decoding.
- **NHTSA** supplies available recall, complaint, and NCAP safety information.
- **FuelEconomy.gov** supplies fuel-economy estimates.
- **Lemonless code** normalizes sources per VIN, preserves source provenance, calculates distance, market context, offers, fees, and P&L, and enforces the business constraints.

For exact arguments, output fields, and validation rules, see the [tool catalog](docs/TOOL_CATALOG.md).

## Proof of AI: an inspectable Find run

The public [Proof page](https://autoflip-umber.vercel.app/proof) contains a recorded comparison using the same buyer request:

> I'm in Denver 80202, budget $25k all-in, need an AWD SUV for mountain winters and a 40-mile daily commute. Two kids, so safety matters most. Under 100k miles, no accident or salvage history, low fuel cost. Within 75 miles. Which one should I buy and what should I offer?

The recorded Lemonless Find run selected a specific **2021 Subaru Forester Premium AWD**:

| Field | Recorded value |
|---|---|
| VIN | \`JF2SKAJC5MH423912\` |
| Asking price | $20,197 |
| Mileage | 89,215 miles |
| Location | Longmont, Colorado |
| Distance | About 28 miles from ZIP 80202 |
| Verdict | Needs inspection |
| Confidence | Medium |
| Opening offer | $19,000 before taxes and fees |
| Vehicle-price walk-away | $20,000 |
| Shopper's all-in ceiling | $25,000 |

**Run record:** 13 November 2026, 20:29:50 UTC · 47.5 seconds · 8 SERV calls · 13 application-tool calls · 12 tool rounds.

The run used the same server-side Find workflow as the product route, with isolated in-memory test state. Its recorded result includes the shortlist, source lookups, SERV decisions, confidence, structured offer, and candidate-level decision trail. The Gemini Chat · Auto answer and its original shared conversation are also linked on Proof: [Gemini comparison](https://share.gemini.google/zr44XVFu8UNW).

This is the project's concrete end-to-end example: a natural-language request becomes a local listing recommendation with vehicle evidence, market context, a structured offer, and a reviewable execution record.

## External AI-agent access

Lemonless exposes agent discovery metadata and a paid API:

- [Agent card](https://autoflip-umber.vercel.app/.well-known/agent.json)
- [OpenAPI](https://autoflip-umber.vercel.app/openapi.json)
- [llms.txt](https://autoflip-umber.vercel.app/llms.txt)
- [Developer guide](https://autoflip-umber.vercel.app/developers)
- MCP over JSON-RPC HTTP: \`POST /api/mcp\`

### MCP tools

The MCP server exposes the following tools:

| Tool | Description |
|---|---|
| \`get_payment_info\` | Public onboarding and payment instructions; no API key required. |
| \`check_car\` | Check a listing URL, VIN, or pasted listing. |
| \`find_cars\` | Start an asynchronous Find run. |
| \`find_cars_status\` / \`find_cars_result\` | Poll and retrieve the Find result. |
| \`resale_search\` | Start an asynchronous Resale job. |
| \`resale_status\` / \`resale_result\` | Poll and retrieve the Resale result. |
| \`deal_radar\` | Run a direct Radar scan when the global test-mode gate permits it. |
| \`radar_watches\` | List the caller's saved watches. |
| \`radar_save_watch\` | Save a Find or Resale watch. |
| \`radar_check_now\` | Check enabled watches now, when permitted by the Radar test gate. |
| \`radar_feed\` | Retrieve recent alerts. |
| \`full_report\` | Generate a full VIN-scoped report. |

Agent REST routes are under \`/api/v1\`:

- \`POST /api/v1/check\`
- \`POST /api/v1/find\`, \`GET /api/v1/find/:runId/status\`, \`GET /api/v1/find/:runId\`
- \`POST /api/v1/resale\`, \`GET /api/v1/resale/:jobId/status\`, \`GET /api/v1/resale/:jobId\`
- \`GET/POST /api/v1/radar/*\`
- \`POST /api/v1/report\`
- \`GET /api/v1/receipts\` and \`GET /api/v1/receipts/:receiptId\`

Agent keys use the \`af_\` prefix and the \`Authorization: Bearer af_…\` header. Keys are scoped (\`read\`, \`check\`, \`find\`), rate-limited, and associated with a verified account owner. See [MCP authentication](docs/agents/OPENSERV_MCP_AUTH.md).

### x402 payments

The agent payment layer implements **x402 v2 exact payments in USDC on Base Mainnet**:

- Network: \`eip155:8453\`
- Asset: Base USDC (\`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913\`)
- Default receiver: \`0x250aC40Ab38E4f023c33C1c3DFD0Cd07357Fbf79\`
- Facilitator: Coinbase CDP hosted x402 facilitator by default.

| Agent action | Endpoint | Amount |
|---|---|---:|
| Register an agent and receive an \`af_\` key | \`POST /api/agents/register\` | $0.01 USDC |
| Run one direct full report | \`POST /api/v1/report\` | $3.00 USDC |
| Buy 3 report credits | \`POST /api/agents/billing/credits\` · \`pack_3\` | $9 USDC |
| Buy 10 report credits | Same endpoint · \`pack_10\` | $25 USDC |
| Radar · 1 saved watch / up to 300 monthly reviews | \`POST /api/agents/billing/plans\` · \`radar\` | $100 USDC / 30 days |
| Radar Pro · 3 saved watches / up to 900 monthly reviews | Same endpoint · \`radar_pro\` | $250 USDC / 30 days |

x402 is enabled when CDP facilitator credentials are configured. The readiness endpoint is \`GET /api/agents/payment-info\`. The receiving wallet's private key is not stored in Lemonless. Human browser checkout is separate and remains in Stripe **Test Mode**.

## Architecture map

| Area | Implementation |
|---|---|
| SERV profile registry and HTTP transport | \`src/server/serv/\` |
| Find tool loop and tool handlers | \`src/server/find-agent/\` |
| Resale tool loop and tool handlers | \`src/server/resale-agent/\` |
| Check pipeline | \`src/server/check/\` |
| Deal Radar cycle and SERV reviews | \`src/server/radar-cycle.ts\`, \`src/server/radar-serv.ts\` |
| SERV and application decision records | \`src/server/serv/proof.ts\`, \`src/domain/decision-proof-record.ts\` |
| Vehicle normalization and evidence provenance | \`src/domain/normalized-vehicle.ts\` |
| Pricing, verdict, and guardrail calculations | \`src/domain/\` |
| MCP tool definitions and JSON-RPC server | \`src/server/mcp.ts\`, \`src/app/api/mcp/route.ts\` |
| Agent authentication, scopes, and payments | \`src/server/agent-auth.ts\`, \`src/server/x402-payments.ts\` |
| Automated tests and acceptance suite | \`src/**/*.test.ts\`, \`e2e/\`, \`test/\` |
| SERV evaluation artifacts | \`eval/\` |

For a system-level diagram and the responsibilities of the main layers, see [Architecture](docs/ARCHITECTURE.md).

## Run locally

Requires **Node.js 22**.

~~~bash
npm ci
cp .env.example .env.local
npm run dev
~~~

The UI starts at \`http://localhost:3000\`. For live Find/Resale runs, configure \`SERV_API_KEY\`, \`AUTODEV_API_KEY\`, and a persistent store. For local tests, the test suite uses controlled fixtures and stub upstreams.

### Core verification

~~~bash
npm run typecheck
npm test
npm run golden
npm run test:acceptance:find-radar-serv
npm run test:e2e:find-radar-http
npm run test:e2e
npm run build
npm run boundary:source
npm run boundary:next
~~~

CI runs the same type, import-boundary, unit, golden replay, Find/Radar acceptance, HTTP e2e, Playwright, production build, and production bundle checks. The production dependency audit is a merge gate.

### SERV evaluation commands

~~~bash
npm run eval:serv
npm run eval:trace
npm run eval:verdict
npm run eval:comparison
~~~

- \`eval:serv\` runs the profile evaluation against SERV and requires \`SERV_API_KEY\`.
- \`eval:trace\` runs a fixed SERV fixture and writes a redacted Proof of AI trace; it requires \`SERV_API_KEY\`.
- \`eval:verdict\` measures the verdict decision fixture set against the SERV profile; it requires \`SERV_API_KEY\`.
- \`eval:comparison\` runs the configured comparison harness. Review its safety and provider gates before enabling live runs.

The committed evaluation artifacts are in \`eval/results/\`. A missing API key is never treated as a measured success.

## Environment configuration

See [.env.example](.env.example) for the complete list. Important variables:

| Variable | Purpose |
|---|---|
| \`SERV_API_KEY\` | OpenServ SERV Reasoning API key. |
| \`SERV_BASE_URL\` | SERV API base URL; defaults to \`https://inference-api.openserv.ai/v1\`. |
| \`SERV_MODEL\` | Optional base model override; production default is \`gpt-6.1-sol\`. |
| \`SERV_PROFILE_MODEL_<PROFILE>\` | Optional profile-level model override; model allowlisting is enforced. |
| \`AUTODEV_API_KEY\` | Auto.dev inventory access. |
| \`UPSTASH_REDIS_REST_URL\` / \`UPSTASH_REDIS_REST_TOKEN\` | Shared persistent state for deployed sessions, quotas, credits, watches, and checkpoints. |
| \`AUTH_SECRET\`, \`AUTH_GOOGLE_ID\`, \`AUTH_GOOGLE_SECRET\` | Auth.js and Google sign-in. |
| \`NEXT_PUBLIC_FIREBASE_*\` | Firebase email-link sign-in configuration. |
| \`STRIPE_SECRET_KEY\` / \`STRIPE_WEBHOOK_SECRET\` | Human checkout. The server accepts Stripe test keys only. |
| \`CDP_API_KEY_ID\` / \`CDP_API_KEY_SECRET\` | Coinbase CDP facilitator credentials for x402. |
| \`X402_PAY_TO_ADDRESS\` | Optional USDC receiver override. |
| \`RADAR_CRON_SECRET\` | Bearer secret used by the scheduled Radar route. |
| \`RADAR_TEST_MODE\` | Controls the bounded one-notification Radar test mode. On Vercel, test mode is enabled by default unless set to \`0\`. |
| \`LEMONLESS_ADMIN_EMAILS\` | Comma-separated allowlist of verified administrator emails. |

Use Upstash for shared production state. The Vercel runtime is multi-instance; spend-sensitive and Radar safety paths fail closed when shared state cannot be verified.

## Current test and release configuration

- Stripe human checkout remains in **Test Mode**.
- The deployed Deal Radar is in bounded one-notification test mode by default: one project-wide watch, one uncached inventory lookup and one candidate review per cycle, with a three-cycle ceiling. After the first notification, all new monitoring checks are globally paused. An administrator can re-arm the test; set \`RADAR_TEST_MODE=0\` to run normal Radar operation.
- Find and Resale share the temporary two-session test limit per non-admin account. The verified administrator allowlist bypasses that limit; the Account admin panel can grant additional combined Find/Resale sessions to a verified user.
- The daily Radar schedule is configured in \`vercel.json\` at 14:00 UTC.

## License

MIT. See [LICENSE](LICENSE).
