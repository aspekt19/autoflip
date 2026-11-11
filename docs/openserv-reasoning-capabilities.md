# OpenServ Reasoning capabilities (Lemonless)

Single registry of every documented OpenServ **SERV Reasoning** capability and where Lemonless uses it. Source of truth for wiring: `src/server/serv/profiles.ts` (`DOCUMENTED_FEATURES`, `PROFILES`, `featuresUsedBy`).

**Hackathon ban:** OpenServ **Graph** is forbidden in contest code, architecture, demos, and claims — directly or indirectly. Kronos / Multipath model suffixes are separate SERV Reasoning features, not Graph.

Docs index: [OpenServ SERV Reasoning](https://docs.openserv.ai/llms.txt).

## Capability → step → why

| Capability | Mechanism | Steps that use it | Why here |
|---|---|---|---|
| **Prompt Guard** | `serv_prompt_guard` tool | All untrusted-input and shopper-facing profiles: `*_guard`, `need_extract`, `find_plan`, `find_triage`, `find_decide`, `find_challenge`, `find_pick`, `find_next_check`, `find_close_call_multipath`, `listing_extract`, `check_rules`, `report_*`, `agent_*`, `radar_*`, `flip_*`, `verdict_*`, `resale_*`, `scout_plan`, `telegram_reply`, `personal_alert_review` | User / listing text is untrusted; guard blocks injection that would leak or override system instructions ([tools](https://docs.openserv.ai/serv-reasoning/tools.md)). |
| **Output content filter** | Default on (`contentFilter: "default_on"`). Never send `serv_disable_content_filter` | Every profile | Keeps system prompts from leaking into shopper-visible text. Disabling the filter does not fit any Lemonless step. |
| **Shadow Agent** | `serv_shadow_agent` (hint + `max_iterations`; **non-stream only**) | Hard judgment / prose: `report_explain`, `agent_explain`, `personal_alert_review`, `flip_judge`, `verdict_decide`, `verdict_challenge`, `find_pick`, `find_decide`, `find_challenge`, `resale_plan_search`, `resale_triage`, `resale_pick`, `resale_challenge`, `radar_review`, `scout_plan` | Validate-and-revise loop on decisions that shoppers see or that pick among allowlisted options ([shadow agent](https://docs.openserv.ai/serv-reasoning/tutorials/shadow-agent.md)). |
| **Kronos** | Model suffix `-serv-kronos` | Procedural rules: `check_rules`, `flip_feasibility` | Audits/repairs the generated reasoning prompt for multi-condition rule text ([Kronos](https://docs.openserv.ai/serv-reasoning/tutorials/kronos.md)). |
| **Multipath** | Model suffix `-serv-multipath` | Branching policy: `flip_judge`, `verdict_decide`, `verdict_challenge`, `find_pick`, `find_close_call_multipath`, `find_triage`, `find_decide`, `find_challenge`, `resale_*`, `radar_review`, `scout_plan` | Competing branches / exceptions in system instructions ([Multipath](https://docs.openserv.ai/serv-reasoning/tutorials/multipath.md)). |
| **Kronos + Multipath** | Combined suffix `-serv-kronos-multipath` | Plan / extract / next-check: `need_extract`, `find_plan`, `find_next_check` | Branching *and* procedural plan schemas where invented quotes/models must stay clamped. |
| **Structured outputs** | `response_format.json_schema` (`jsonSchema` on profile) | Every machine-consumed decision: Find plan/pick/triage/decide/challenge/next-check/close-call, Resale plan/triage/pick/challenge, Radar review, Scout plan, Flip judge, Verdict decide/challenge, `need_extract`, `listing_extract` | Software clamps allowlists; schema is required when code consumes JSON ([structured outputs](https://docs.openserv.ai/serv-reasoning/tutorials/structured-outputs.md)). |
| **Reasoning effort** | `reasoning_effort` (`none` / `low` / `medium`) | All profiles (`none` only when chat + application function tools require it: `report_explain`, `agent_explain`, `personal_alert_review`) | Day-one default low; medium for multi-constraint decides; none when OpenAI chat rejects function tools with effort ([reasoning effort](https://docs.openserv.ai/serv-reasoning/tutorials/reasoning-effort.md)). |
| **Prompt cache** | Default on (`promptCache: "default"`) | Every profile | Stable system prompts; variable facts stay in the user message ([prompt caching](https://docs.openserv.ai/serv-reasoning/tutorials/prompt-caching.md)). Opt-out unused. |
| **Streaming** | `stream: true` | `telegram_reply` only | Short prose to Telegram; Shadow cannot combine with streaming ([streaming](https://docs.openserv.ai/serv-reasoning/tutorials/streaming.md)). |
| **Application tools** | Non-`serv_*` function tools | `report_explain`, `agent_explain` → `read_computed_facts` | Exact numbers come from code facts, not model memory ([application tools](https://docs.openserv.ai/serv-reasoning/tutorials/tools.md)). |
| **Usage / billing telemetry** | Proof log copies `usage` on every call | Every profile (`featuresUsedBy` always includes `usage`) | Cost, latency, and feature outcomes for monitoring ([usage](https://docs.openserv.ai/serv-reasoning/tutorials/usage-and-billing.md)). |
| **Chat Completions endpoint** | `POST /v1/chat/completions` (`endpoint: "chat"`) | **All** profiles | Owner default for every SERV step. Responses / Messages are not used. |
| **Responses API** | `POST /v1/responses` | *None* (intentionally unused) | Documented OpenServ surface; Lemonless standardizes on chat/completions. |
| **`serv_disable_content_filter`** | Opt-out tool | *None* (intentionally unused) | Shopper-facing prompts must not be quoted back. |
| **OpenServ Graph** | Graph product | **Forbidden** | Contest ban (t257/t258). Not in `DOCUMENTED_FEATURES`. |

## Coordination defaults (shared `profiles.ts`)

Owned here so parallel PRs stay aligned:

| Owner agent | Profiles | Coordinated defaults |
|---|---|---|
| **bc-b40c892e** (decide / second check) | `find_triage`, `find_decide`, `find_challenge` (+ shared `verdict_decide` / `verdict_challenge`) | Triage: **multipath** + **prompt_guard** + strict schema (no shadow — latency for C2). Decide + challenge: **multipath** + **prompt_guard** + **shadow** + strict schema. `BASE_MODEL` = `gpt-6.1-sol`, chat only. |
| **bc-999715fc** (resale / radar / agents) | `resale_plan_search`, `resale_triage`, `resale_pick`, `resale_challenge`, `radar_review`, `scout_plan`, agent explain/guard | Plan/triage/pick/radar/scout: **multipath** + **prompt_guard** + **shadow** + schema. Challenge: same (second-check accuracy). Content filter on; Graph off. |

Product contract for Resale/Radar allowlists remains in [`resale-serv-capabilities.md`](./resale-serv-capabilities.md).

## Model default

Production `BASE_MODEL` = **`gpt-6.1-sol`** (override with env `SERV_MODEL` or `SERV_PROFILE_MODEL_<PROFILE>`). Feature suffixes append via `modelFor()`.
