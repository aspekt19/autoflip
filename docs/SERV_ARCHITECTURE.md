# OpenServ SERV architecture

This document describes the production SERV integration in Lemonless and follows the implementation in the SERV runtime, Find/Resale agent loops, Check pipeline, and Deal Radar.

## 1. Integration overview

Lemonless uses OpenServ SERV Reasoning as its model inference and reasoning layer. The deployed application sends OpenAI-compatible HTTP requests to the configured SERV endpoint.

- Default base URL: **https://inference-api.openserv.ai/v1**
- Authentication: **SERV_API_KEY**
- Production base model: **gpt-6.1-sol**, declared as BASE_MODEL in the profile registry.

Find and Resale are stateful agent workflows. They are not a single prompt that returns a static recommendation. Each workflow can span multiple SERV turns and application-tool rounds:

1. SERV interprets the shopper's intent.
2. SERV asks a clarifying question when material information is missing.
3. SERV submits a structured brief.
4. The shopper confirms or corrects the brief.
5. SERV chooses application function tools.
6. Lemonless executes the selected tools against inventory, vehicle-data providers, or deterministic calculation modules.
7. Tool outputs and evidence are returned to SERV for the next reasoning turn.
8. SERV evaluates candidates and submits a terminal decision.
9. TypeScript validates the decision, persists its journal, and prepares the shopper-facing result.

The division of responsibility is deliberate: SERV owns intent interpretation, tool selection, candidate evaluation, and recommendation. Lemonless code owns provider execution, data provenance, arithmetic, allowlists, hard constraints, and persisted evidence.

## 2. Source map

| File | Responsibility |
|---|---|
| **src/server/serv/profiles.ts** | BASE_MODEL, task-specific profile registry, system instructions, schemas, feature selection, endpoints, timeouts, and fallbacks. |
| **src/server/serv/profile-models.ts** | Per-profile base-model resolution and production model allowlisting. |
| **src/server/serv/run.ts** | Profile request construction, SERV HTTP transport, structured-output parsing, usage extraction, retry/recovery, and proof creation. |
| **src/server/serv/agent-serv-features.ts** | Per-step Prompt Guard, Kronos, Multipath, and Shadow Agent policy for Find and Resale. |
| **src/server/serv/agent-chat-turn.ts** | Multi-turn Chat Completions and Responses transport. |
| **src/server/serv/agent-tool-loop-protocol.ts** | Responses reasoning/function-call preservation and function_call_output pairing. |
| **src/server/serv/agent-loop-checkpoint.ts** | Serializable checkpoints for long-running Find/Resale agent loops. |
| **src/server/serv/call-step.ts** | Retry, schema-validation, repair, critical-stop, and optional-degradation policy for profile calls. |
| **src/server/serv/proof.ts** | Shared SERV proof recorder and response metadata normalization. |
| **src/server/find-agent/loop.ts** | Find agent orchestration, tool rounds, checkpointing, and terminal selection. |
| **src/server/find-agent/tools.ts** | Find application function-tool schemas, argument validation, and execution. |
| **src/server/resale-agent/loop.ts** | Resale agent orchestration, code-computed P&L context, and terminal selection. |
| **src/server/resale-agent/tools.ts** | Resale function-tool schemas, P&L tool, validation, and execution. |
| **src/server/radar-serv.ts** | SERV review and challenge calls used by Deal Radar. |

## 3. Profile registry

PROFILES in src/server/serv/profiles.ts is the central registry. Each profile defines its task, instructions, SERV feature route, endpoint, reasoning effort, response schema, timeout, fallback, and code-computed facts.

### Profile catalogue

| Profile | Purpose | Configured SERV contract |
|---|---|---|
| **find_plan** | Convert a buyer note into a structured plan and search directions. | Kronos + Multipath, Prompt Guard, strict find_plan schema. |
| **check_guard** | Screen a listing URL or VIN before Check. | Prompt Guard. |
| **listing_extract** | Extract visible listing fields from fetched page text. | Prompt Guard and strict listing_extract schema. |
| **check_rules** | Apply VIN and listing rules to supplied facts. | Kronos + Prompt Guard. |
| **report_guard** | Screen the lookup before a Personal or Flip report. | Prompt Guard. |
| **report_explain** | Explain calculated facts in a shopper report. | Prompt Guard + Shadow Agent; Responses API; forced read_computed_facts application tool. |
| **agent_guard** | Screen external-agent lookups. | Prompt Guard. |
| **agent_explain** | Explain a report for an external agent. | Prompt Guard + Shadow Agent; Responses API; read_computed_facts. |
| **radar_guard** | Screen saved-search text before a Radar cycle. | Prompt Guard. |
| **flip_feasibility** | Apply resale feasibility rules before an alert decision. | Kronos + Prompt Guard. |
| **flip_judge** | Choose alert or skip using code-computed flip facts. | Multipath + Prompt Guard + Shadow Agent; strict flip_alert_judgment schema. |
| **verdict_decide** | Choose buy, negotiate, pass, or needs_inspection. | Strict report_verdict_decision schema. |
| **verdict_challenge** | Independently challenge a report verdict. | Strict report_verdict_challenge schema. |
| **find_close_call_multipath** | Compare close candidates across price, risk, and total-cost paths. | Strict find_close_call_multipath schema. |
| **find_pick** | Select a Find finalist from an allowlisted candidate set. | Strict find_pick schema and task-specific Shadow Agent hint. |
| **find_triage** | Triage the Find pool and request targeted checks or one revisit. | Strict find_triage schema. |
| **find_decide** | Select the final Find shortlist winner and action. | Strict find_decide schema. |
| **find_challenge** | Challenge or revise a Find decision using supplied evidence IDs. | Strict find_challenge schema. |
| **resale_plan_search** | Choose allowlisted inventory segments for a budget-first flip search. | Strict resale_plan_search schema. |
| **resale_triage** | Choose Resale candidates and allowlisted deep checks. | Strict resale_triage schema. |
| **resale_pick** | Choose a Resale finalist using code-computed P&L. | Strict resale_pick schema. |
| **resale_challenge** | Challenge the Resale selection using supplied evidence IDs. | Strict resale_challenge schema. |
| **radar_review** | Review new Resale-watch listings and choose alert or skip. | Multipath + Prompt Guard + Shadow Agent; strict radar_review schema. |

The registry also defines each profile's reasoning effort, output format, endpoint, timeout, and fallback. Profile names describe focused tasks; a single user workflow invokes the profiles appropriate to the route and decision stage.

## 4. SERV capabilities and their role

| SERV capability | Lemonless implementation |
|---|---|
| **Prompt Guard** | Adds the SERV input-gate marker to the first turn of an agent conversation and to protected lookup profiles. Shopper text and fetched listing content are handled as untrusted input. |
| **Kronos** | Adds a rules-focused audit/repair pass to selected planning and decision steps. Find's final agent selection uses the combined Kronos + Multipath route. |
| **Multipath** | Adds alternative reasoning paths for decisions where different evaluation lenses matter. Find's final selection uses Kronos + Multipath; Resale's final selection uses Multipath. |
| **Shadow Agent** | Adds a separate validation pass with a task-specific hint. Find and Resale use it on the dedicated final selection hop; the configured maximum iteration count is two. |
| **Strict JSON Schema** | Constrains machine-consumed plans and decisions to explicit fields and enums. Lemonless validates the returned values again before publication. |
| **Reasoning effort** | Profiles select supported low or medium effort. Agent turns normalize effort to low, medium, or high and never send the unsupported none value. |
| **Prompt caching** | Uses SERV's default prompt-cache behavior with stable system instructions and variable facts in the input. |
| **Content filter** | Keeps the SERV content filter enabled by default. |
| **Responses reasoning state** | Agentic function-tool calls use /v1/responses. Prior reasoning and function-call items are preserved with an output for every call ID on the next turn. |
| **Application tools** | Report-explanation profiles can force read_computed_facts to return the exact numbers computed by Lemonless. |
| **Usage and Proof** | Captures response IDs, requested/reported model, profile, features, tool names, latency, HTTP status, usage when exposed, and decision-proof records. |

There are two distinct tool families in the request:

- **SERV feature markers:** serv_prompt_guard and serv_shadow_agent enable SERV-side capabilities.
- **Lemonless application tools:** search_listings, get_vin_decode, get_market_comps, and the other named business functions execute application-owned provider queries and calculations.
- **read_computed_facts:** an application tool used by report-explanation profiles to read the already-calculated fact set.

Find and Resale use a step policy. Intake and search turns use the base model. Their dedicated final selection hop enables the product-specific reasoning bundle. Prompt Guard is requested on the first SERV call in the conversation rather than repeatedly on every tool round.

## 5. Find and Resale agent feature policy

resolveAgentServStep() in agent-serv-features.ts distinguishes three roles:

| Step | When it runs | Feature policy |
|---|---|---|
| **Intake** | Before the shopper confirms the brief. | Base model; Prompt Guard may be requested on the first conversation call. |
| **Search** | Tool selection and inventory/evidence rounds after brief confirmation. | Base model; Prompt Guard is not repeatedly attached after the first turn. |
| **Verdict** | Dedicated terminal selection hop. | Find: Kronos + Multipath + Shadow Agent. Resale: Multipath + Shadow Agent. |

Output-token ceilings are configured by step:

| Agent step | Maximum output tokens |
|---|---:|
| Intake | 8,192 |
| Search | 16,384 |
| Verdict | 65,536 |

These are request ceilings configured by Lemonless; the deterministic data and decision rules remain in the application.

## 6. Responses function-tool protocol

Agentic Find and Resale use SERV's /v1/responses endpoint for function tools.

For each response, the loop:

1. Extracts function_call output items and their call_id values.
2. Validates the tool name and arguments against the application's tool registry.
3. Executes each accepted function in TypeScript.
4. Creates one function_call_output for every call ID.
5. Replays the previous input prefix, preserved reasoning/function-call items, and the new tool outputs in the next request.

The protocol handles parallel function calls and ensures every returned call has a corresponding output item. A function call is not treated as a completed tool execution until Lemonless has executed it and recorded the output.

The Chat Completions endpoint is used for profile-driven structured decisions and schema-only fallback turns. The production agent fallback does not attach application function tools to Chat Completions; function-tool orchestration stays on Responses.

## 7. Long-running loops and checkpoints

A Find or Resale run can require several SERV turns and provider calls. AgentLoopCheckpointV1 serializes the information needed to continue the same run:

- Responses input items and Chat transcript.
- Current phase and completed tool rounds.
- Tool journal and feature-rejection records.
- Known VINs and listings keyed by VIN.
- Resale P&L facts keyed by VIN.
- Shopper facts, pending question, pending brief, and confirmation state.
- Resolved search center and shopper-approved radius widening state.

The checkpoint is persisted between HTTP requests. A later request restores the same agent state and continues the decision process. Each agent SERV HTTP hop is bounded at 210 seconds so the loop can persist progress and continue within the platform request lifecycle.

## 8. Data boundary and decision validation

SERV receives structured facts and evidence IDs from Lemonless. Its terminal function call is validated before it can become a published result.

Examples of application-side validation:

- A selected VIN must be present in an actual inventory tool result.
- Evidence IDs must belong to the supplied evidence set.
- Offer fields must satisfy the confirmed buyer budget and known asking price.
- Known distance must satisfy the confirmed radius unless the shopper explicitly agrees to widen it.
- Explicit no-accident/no-salvage constraints are checked against the history evidence returned by the source tools.
- Resale buy/negotiation actions require positive code-computed mid-profit.
- submit_nothing_fits records the actual candidate rejections and search evidence.

When no candidate fits, the agent can finish with a structured no-fit decision instead of selecting an unsupported winner.

## 9. Proof and audit trail

ServProof and the shared decision-proof records capture SERV execution metadata. Depending on the endpoint and response, records include:

- Profile and feature list.
- Requested and reported model IDs.
- Response ID and HTTP status.
- Endpoint, reasoning effort, JSON Schema, and application-tool details.
- SERV marker tools and application tool names.
- Latency, usage fields when exposed, and fallback/retry information.
- Whether a Shadow Agent pass was requested and its recorded outcome.
- Code-computed fields supplied to the profile.

Find, Resale, Check, and Radar expose structured journal/proof records through product results. The public Proof page demonstrates the recorded Find workflow.

The redacted trace harness writes execution metadata without storing the raw buyer prompt, VIN, source facts, or free-form model output.

## 10. Model selection and configuration

BASE_MODEL is the production default. Profile model resolution follows this priority:

1. SERV_PROFILE_MODEL_<PROFILE> for a profile-level override.
2. An explicit caller-supplied model such as SERV_MODEL.
3. BASE_MODEL.

profile-models.ts enforces the configured model candidate allowlist. An unsupported model ID is rejected unless SERV_PROFILE_MODEL_ALLOW_UNLISTED=1 is explicitly set after provider-console validation. The production default remains gpt-6.1-sol.

## 11. Tests and evaluation

SERV and agent layers have dedicated unit and acceptance coverage:

- src/server/serv/*.test.ts — profile contracts, feature bundles, request bodies, tool protocol, checkpoint behavior, proof, transport errors, schema handling, and feature-rejection policy.
- src/server/find-agent/*.test.ts — Find loop, budgets, tools, terminal decisions, and evidence validation.
- src/server/resale-agent/*.test.ts — Resale loop and tool behavior.
- src/server/find-radar-serv-acceptance.test.ts — Find/Radar SERV acceptance contract.
- npm run eval:serv — profile evaluation; requires SERV_API_KEY.
- npm run eval:trace — fixed-fixture redacted SERV proof trace; requires SERV_API_KEY.
- npm run eval:verdict — verdict-decision evaluation; requires SERV_API_KEY.

GitHub Actions runs typecheck, source-boundary checks, unit tests, golden replay, Find/Radar SERV acceptance, HTTP e2e with stub upstreams, Playwright, production build, and a built-server import-boundary assertion.

## 12. Key implementation contracts

- SERV_API_KEY — OpenServ SERV Reasoning key.
- SERV_BASE_URL — defaults to the OpenServ inference endpoint.
- BASE_MODEL — gpt-6.1-sol.
- SERV_PROFILE_MODEL_<PROFILE> — optional profile-specific model override.
- SERV_PROFILE_MODEL_ALLOW_UNLISTED=1 — explicit opt-in for a validated non-default model.
- Agent HTTP hop deadline — 210 seconds.
- Agent output ceilings — 8,192 intake; 16,384 search; 65,536 verdict.
- Find/Resale Shadow Agent iteration cap — 2.
