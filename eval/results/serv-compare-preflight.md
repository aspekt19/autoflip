# SERV fair compare preflight (offline — zero network)

Generated: 2026-11-08T17:28:34.619Z
Production BASE_MODEL (unchanged): `gpt-5.4-mini`

## Exact fair-slate model IDs (docs.openserv.ai)

- **gpt-5.4-mini** — provider=`openai` role=`baseline_production_default` endpoint=`chat`
  - Production BASE_MODEL — unchanged by this harness.
  - Known class: cold first-step ~45s timeout under scout_plan.timeoutMs (do not blind-raise).
- **claude-sonnet-4.6** — provider=`anthropic` role=`sonnet_peer` endpoint=`chat`
  - Works on /v1/chat/completions and /v1/messages; scout_plan uses chat.
  - Historically failed on nullable enum `type:['string','null']+enum` — fixed via anyOf[string-enum|null] on toolId/rationaleKind (product A–C; already on this lineage).
  - HTTP 200 alone ≠ grounded decision — score schemaValid/grounded/recovery/antiLoop/refusals.
- **gemini-2.5-flash** — provider=`google` role=`gemini_peer` endpoint=`chat`
  - Gemini is NOT available on /v1/messages or /v1/responses — must use /v1/chat/completions (scout_plan endpoint=chat ✓).
  - google-genai SDK generateContent is unsupported — OpenAI-shape chat only.
  - Score refusals/timeouts/empty/parse-fail honestly; cost remains unknown until billing reconciliation.

Alternates Flip may substitute after console check: `claude-sonnet-5`, `claude-sonnet-5.5`, `gemini-3.5-flash`.

## Resolved fair slate (scout_plan effective IDs)

- request `gpt-5.4-mini` → effective `gpt-5.4-mini` (docs_fair_slate)
- request `claude-sonnet-4.6` → effective `claude-sonnet-4.6` (docs_fair_slate)
- request `gemini-2.5-flash` → effective `gemini-2.5-flash` (docs_fair_slate)

## Protocol issues (integration vs model fault)

### anthropic_nullable_enum — `integration`
Sonnet historically HTTP 400 on nullable enum type:['string','null']+enum (toolId/rationaleKind).
Evidence: Fixed product A–C: anyOf[{type:string,enum:[…]},{type:null}] in scout_plan schema; offline strict-json-schema tests. If 400 returns with old shape, that is integration/schema — not model judgment.

### gemini_endpoint — `integration`
Gemini unsupported on /v1/messages and /v1/responses.
Evidence: docs.openserv.ai/serv-reasoning/api/compatibility — scout_plan endpoint=chat is correct. A messages/responses path failure is integration, not Gemini quality.

### servstepid_execution_owned — `integration`
servStepId must be execution-owned (exec:step-N), not model-authored empty string.
Evidence: Dropped from request schema; planner binds id. Empty-string failures on old schema were integration.

### gpt54_cold_timeout — `unknown_until_live`
GPT-5.4 Mini cold first-step ~45007ms = scout_plan.timeoutMs observed historically.
Evidence: Record as timeout/refusal row; do not blind-raise timeout. Distinguish abort-after-timeout (integration bound) vs empty/refusal (model/upstream).

### grounding_vs_http200 — `model_behavior`
HTTP 200 + schemaValid ≠ grounded recovery.
Evidence: Score grounded/recoveryClass/antiLoopSafe/claimsVehicleDefectFromPlaceholder. Prefer inventory.search / honest abstain / grounded reject over loop.

### sequential_xor_bound — `integration`
SCOUT_COMPARE_SEQUENTIAL=1 must XOR with normal compare (≤2 HTTP total).
Evidence: 66b151e breach was 5 HTTP (3 normal + 2 sequential). compare-cli-dispatch XOR — composition bug was harness integration, not model.

## XOR dispatch bounds (no live)

- dry_run: path=dry_run maxHttp=0
- live+sequential: path=sequential_two_decision maxHttp=2 (XOR — normal skipped)
- live normal: path=normal_compare maxHttp=null

## Saved evidence (SAME scenarios)

- Ledger: `offline_sanitized_NOT_live_rerun` runId=ff52a261-7ac0-4bd1-8433-36532eea2a54 deployedSha=de5eb0c0dab6d394765ff5916abf6346dc139841
- Historical labeled actions scored offline: 2
  - step-1: recovery=grounded_reject_unusable_ask grounded=true antiLoopSafe=true (observedOk=false)
  - step-2: recovery=grounded_reject_unusable_ask grounded=true antiLoopSafe=true (observedOk=false)

## Catalog note
```
In-repo catalog (default; production BASE_MODEL unchanged):
  - gpt-5.4-mini (src/server/serv/profiles.ts BASE_MODEL + README SERV_MODEL default); scout_plan effective=gpt-5.4-mini
  - gpt-5.4-mini-2026-03-17 (eval/results/latest.json + eval/results/serv-proof-trace.json reported model); scout_plan effective=gpt-5.4-mini-2026-03-17
Docs fair slate (SCOUT_COMPARE_FAIR_SLATE=1 or explicit SERV_COMPARE_MODELS):
  - gpt-5.4-mini [openai] (docs fair slate (https://docs.openserv.ai/serv-reasoning/models) — Flip must confirm console enablement before paid run); scout_plan effective=gpt-5.4-mini
  - claude-sonnet-4.6 [anthropic] (docs fair slate (https://docs.openserv.ai/serv-reasoning/models) — Flip must confirm console enablement before paid run); scout_plan effective=claude-sonnet-4.6
  - gemini-2.5-flash [google] (docs fair slate (https://docs.openserv.ai/serv-reasoning/models) — Flip must confirm console enablement before paid run); scout_plan effective=gemini-2.5-flash
Console vs catalog: OpenServ console Available-models table may be broader (e.g. gpt-6-luna). Those IDs are NOT auto-allowlisted — no scrape, no cheapest-forced pick.
Unlisted IDs outside fair slate: SERV_COMPARE_MODELS=… + SCOUT_COMPARE_ALLOW_UNLISTED=1 after Flip console/contract validation.
Budget-conscious ≠ cheapest-at-expense-of-quality — compare recovery/groundedness/refusals/latency, not rate-table shopping.
Model-only swap is NOT the demonstrated fix for the PR63 placeholder-price reject deadlock.
Protocol: Gemini → chat only; Anthropic nullable enums → anyOf (already on lineage); Mini cold-timeout class separate.
```

## Flip ready-run commands (parent only — spends SERV)

### 0) Offline dry-run (safe; this agent already runs this class)
```bash
npm run eval:scout-model-compare
SCOUT_COMPARE_FAIR_SLATE=1 npm run eval:scout-model-compare
npm run eval:serv-compare-preflight
```

### 1) Fair three-model SAME-ledger compare (normal path; records refusals/timeouts/latency/tokens; cost=unknown)
```bash
SERV_API_KEY=… SCOUT_COMPARE_ALLOW_PAID=1 SCOUT_COMPARE_FAIR_SLATE=1 \
  SERV_COMPARE_MODELS=gpt-5.4-mini,claude-sonnet-4.6,gemini-2.5-flash \
  npm run eval:scout-model-compare
```

### 2) Sequential TWO-decision XOR probe (≤2 HTTP total; Mini or one peer — not stacked on normal)
```bash
SERV_API_KEY=… SCOUT_COMPARE_ALLOW_PAID=1 SCOUT_COMPARE_SEQUENTIAL=1 \
  SERV_COMPARE_MODELS=gpt-5.4-mini \
  SCOUT_COMPARE_SOURCE_PIN='{"head":"<PR77_HEAD>","tree":"<PR77_TREE>","base":"cursor/find-nav-provenance-ecfd-1033"}' \
  npm run eval:scout-model-compare
```

### Scoring contract (genuine — not catalogs-as-results)
- Per step: schemaValid, grounded, recoveryClass, antiLoopSafe, claimsVehicleDefectFromPlaceholder
- Transport: rawStatus, latencyMs, tokens, finishReason, upstreamResponseId, error (timeouts/refusals/empty recorded)
- cost always `unknown` until central billing reconciliation
- Model-only swap is NOT the demonstrated PR63 product fix

## Not run by this preflight
- No SERV_API_KEY read for live calls
- No provider / Auto.dev / browser
- No PR71 merge; XOR/sequential ported selectively onto PR77
