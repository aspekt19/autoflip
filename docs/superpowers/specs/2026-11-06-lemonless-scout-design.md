# Lemonless Scout — Design Spec (Edition02)

**Date:** 2026-11-06  
**Mandate ref:** owner t249 (2026-11-06 23:19 Europe/Istanbul) — full carte blanche for reversible technical choices; no spend / seller contact / new paid Auto.dev or SERV calls; no new accounts; model config unchanged; preserve branding and PR53 search work.

**Hackathon ban (t257/t258):** OpenServ **Graph** is forbidden in contest code/architecture/demo/claims (direct or indirect). See `2026-11-06-openserv-graph-ban.md`. Ordinary mermaid diagrams and Next.js `openGraph` meta are not Graph. Lemonless purpose remains autonomous used-car search/selection (≤5 investigate candidates or abstain), not a report generator or tech showroom.

## 1. Problem

Lemonless already computes honest economics, ordered gates, and SERV-assisted reports. It does **not** yet run a bounded **autonomous investigation loop** where SERV chooses which candidates and which allowed tools to run, then returns ≤5 evidence-backed **INVESTIGATION** candidates (or an honest abstain) with provenance.

## 2. Goals

1. **Vertical slice (flip-first demo OK; both modes required):** validated personal/flip mandate → honest inventory adapter → SERV selects candidate/tool from a bounded allowlist → deterministic evidence + economics → verification/gates → reject / research / replace as warranted → ≤5 investigation candidates or honest abstain.
2. **Roles:** SERV chooses; deterministic TypeScript owns math, facts, hard gates, budgets, permissions, and provenance. Unknown ≠ pass.
3. **Claim hygiene:** asking prices only (not sold prices); title/history and actual repair often unavailable — never fabricate profit certainty or mark unknown facts as pass. Highlight seller claims vs verified / assumed / unknown. Unknown history may still allow listing an investigation candidate; it forbids claiming a verified safe buy/profit.
4. **OpenServ usefulness (corrected):** maximum useful OpenServ is **not** “inference-only by default with SDK postponed.” Map current platform surfaces (SERV Reasoning + `@openserv-labs/sdk` Agent capabilities / task lifecycle / progress / file artifacts) to concrete user benefit and implement feasible local adapters. Distinguish **local integration** from **remote deployment**. Do not add blockchain, x402, Reppo, or swarm for badges. Do not promise a host performs hidden planning.
5. **Safety:** paid-executing scout endpoints default **OFF**; ownership / auth / rate / quota / cost controls; no unauthenticated credit burn. Existing source/call limits remain explicit. No sample fallback in consumer production scout paths.

## 3. Non-goals (this slice)

- Live paid Auto.dev or SERV efficacy runs (owner must approve later).
- Auto-merge / deploy of unverified scout.
- Seller contact, messaging, payments, secret disclosure.
- Guaranteeing performance vs baseline.
- Changing SERV model configuration (`SERV_MODEL` / profiles).

## 4. Contracts

### 4.1 Mandate

```ts
type ScoutMode = "personal" | "flip";

type ScoutMandate = {
  mode: ScoutMode;
  budgetUsd: number | null;          // required for personal when known
  budgetKnown: boolean;
  targetProfitUsd: number | null;    // flip target; null = unknown
  repairAbility: "none" | "minor" | "major" | "unknown";
  preferredMakes: string[];
  openToOtherMakes: boolean;
  zip: string | null;
  maxDistanceMiles: number | null;
  notes: string | null;
};
```

Validation rejects empty/invalid ZIP when distance is set, negative budgets, and unknown modes. Flip mode may omit personal budget.

### 4.2 Canonical tool IDs (allowlist)

| ID | Owner | Cost class | Notes |
|----|-------|------------|-------|
| `inventory.search` | inventory adapter | paid_listings \| replay | Never arbitrary URLs |
| `listing.normalize` | deterministic | free | Treat listing injection as data |
| `evidence.asking_price` | deterministic | free | Seller claim |
| `evidence.comps_ask` | deterministic | free/paid | Asking-price comps only |
| `evidence.gov_recalls` | gov adapter | free_quota | May be unavailable |
| `evidence.gov_fuel` | gov adapter | free_quota | May be unavailable |
| `economics.flip_estimate` | deterministic | free | Labeled assumptions |
| `economics.personal_fit` | deterministic | free | Mandate fit |
| `gates.verify` | deterministic | free | Hard gates; not overridable |
| `candidate.reject` | runner | free | With reason + provenance |
| `candidate.replace` | runner | free | Pull next from pool under budget |
| `run.checkpoint` | store | free | Ownership-isolated |
| `run.finalize` | runner | free | ≤5 or abstain |

No model-set credentials. No tool that fetches arbitrary URLs. No tool that silently substitutes sample inventory in production scout.

### 4.3 State machine

States: `created` → `mandate_validated` → `inventory_loaded` → `selecting` → `tool_running` → `verifying` → `rejecting` | `replacing` → `selecting` … → `finalizing` → `completed` | `abstained` | `failed`.

Terminal failure reasons (explicit, never silent autonomy fallback):

- `serv_refused` | `serv_timeout` | `serv_unavailable`
- `budget_exhausted`
- `provider_unavailable` | `inventory_empty` | `inventory_unconfigured`
- `unauthorized` | `scout_disabled`
- `invariant_violation`

**Hard rule:** if SERV refuses or times out, STOP with partial/abstain/error. Never silently fall back to deterministic selection while claiming autonomy.

### 4.4 Budgets (server-owned, immutable per run)

Configurable hard ceilings with conservative defaults (not assumed adequate for all workloads):

| Ceiling | Default | Meaning |
|---------|---------|---------|
| `maxServCalls` | 8 | Planner/selector calls |
| `maxToolCalls` | 40 | Allowlisted tool invocations |
| `maxProviderCalls` | 0 **now** | Live Auto.dev / paid; stay 0 until owner approves |
| `maxCandidatesOut` | 5 | Investigation slots |
| `maxWallMs` | 120_000 | Wall clock |
| `maxConcurrent` | 1 | Per owner run key |

Idempotent execution: duplicate tool calls with same idempotency key reuse prior result and do not double-count paid quotas; retries still count toward `maxToolCalls` when they re-enter execution.

### 4.5 Investigation candidate output

Each candidate carries:

- listing identity (VIN/year/make/model) + asking price (seller claim)
- evidence map: `{ claim, verified, assumed, unknown }`
- economics with assumption labels
- gate results (pass/forbid/withhold) — hard gates cannot be overridden
- disposition: `investigate` | `rejected` | `replaced`
- provenance: tool IDs, timestamps, fixture/source ids, SERV plan step ids when present

Abstain when zero investigation-worthy candidates remain after honest evaluation.

### 4.6 Auth / cost / flag

- `SCOUT_ENABLED` default **false** (also `false` when unset).
- Paid-executing paths require a live `af_` API key (existing resolve) **and** positive credit balance / quota reservation when provider calls are enabled.
- PR54 auth is not assumed live; scout must not invent a new public unauthenticated burn path. Unauthenticated requests get `401`/`403` with explicit error codes even when flag is on.
- Rate: per-user scout run start quota (in-memory + KV when available).

### 4.7 OpenServ mapping (useful features)

**Two distinct products (do not conflate):**

| Surface | What it is | Console / docs signal |
|---------|------------|------------------------|
| **SERV Reasoning** | Inference API (`inference-api.openserv.ai`) + `SERV_API_KEY`. Wire-compatible chat/responses/messages. **SERV Tools** (`serv_prompt_guard`, default content filter, `serv_shadow_agent`) are request-side validation features — not model-callable functions. | `console.openserv.ai` signed-out → `/login?redirect=%2Foverview`, branded **SERV Reasoning**. Docs: `/serv-reasoning/introduction`, `/models`, `/tools`, `/api`. **Not proof of marketplace/agent access.** |
| **OpenServ platform SDK** (`@openserv-labs/sdk`) | Agent hosting: capabilities, task lifecycle, files, workspace. Separate from Reasoning console login. | Requires developer agent registration + `OPENSERV_API_KEY` + public endpoint. |

| Feature | User benefit for Scout | This slice |
|---------|------------------------|------------|
| SERV Reasoning inference (`runServ`) | Bounded planner chooses next allowlisted tool/candidate | Mock plans offline; live gated by `SCOUT_ALLOW_SERV_PLANNER` + key + `maxServCalls`. **No spend from this worker until parent assigns a bounded paid test** (keep ≥$5 reserve; balance/pricing unverified here). |
| `serv_prompt_guard` | Reduce prompt-injection / instruction-extraction on planner prompts | Already used by existing SERV profiles; scout planner must keep it on when live. |
| Default content filter | Blocks system-prompt leakage in outputs | Leave enabled (do **not** send `serv_disable_content_filter` for scout). |
| `serv_shadow_agent` | Validate-and-revise planner JSON / hard outputs | Use with scout hint (allowlist-only JSON action; no invented sold prices/history). Profiles already support shadow; scout live path reuses. |
| Application tools alongside `serv_*` | Model can call allowlisted scout tools if exposed | Runner executes allowlist in-process; do not forward arbitrary URLs. |
| `@openserv-labs/sdk` `Agent.addCapability` | Same scout tools as registered capabilities | Local adapter builds Agent; **does not** claim remote deployment or marketplace listing. |
| `completeTask` / `updateTaskStatus` / `uploadFile` | Progress + evidence artifact | Wired when action workspace present; skipped locally. |
| Secrets / integrations / x402 / ERC-8004 / swarm | — | **Out of scope** (no badges) |

**Prerequisites for remote OpenServ agent hosting:** developer account, agent registration, `OPENSERV_API_KEY`, public endpoint, accurate capabilities description. Documented; not pretended operational in this PR.

**Spend policy (t249 + follow-up):** existing OpenServ credits may later be used with ≥$5 retained, but **this worker must not spend** until parent assigns an exact bounded paid test after balance/pricing/safe-reserve accounting are verified. Exact estimated-ceiling formula is **not** established in public docs; do not invent tokens×rate enforcement. Platform `generate()` may bill a **different** credit pool than SERV Reasoning — keep auth worlds separate. No wallet/`provision()` / platform paid generate from this worker.

### 4.8 Documented safety/output options (configurable; measure before enabling)

Working source material from public docs research (validated against official pages; **not** code/runtime proof; researcher tags **D≠R**). Do not treat docs as diagnosis of PR52 failures.

| Option | Doc link | Default in scout | Notes |
|--------|----------|------------------|-------|
| Day-one split: SERV selects next action/tools; app does deterministic work | https://docs.openserv.ai/serv-reasoning/day-one | Core architecture | Arithmetic/rules stay in TS tools |
| App function tools + `serv_prompt_guard` markers coexist | https://docs.openserv.ai/serv-reasoning/tools | `promptGuard: true` | Markers stripped server-side |
| Default content filter | same + content-filter tutorial | **always on** | Never send `serv_disable_content_filter` casually; filter refusals ≠ proven PR52 root cause |
| `serv_shadow_agent` | https://docs.openserv.ai/serv-reasoning/tutorials/shadow-agent | **off** until measured | Non-stream; extra cost × iterations |
| Strict `response_format` JSON schema | https://docs.openserv.ai/serv-reasoning/tutorials/structured-outputs | schema ready; **app-side validate + refusal handling required** | Implemented in `plan-parse.ts` |
| Kronos / Multipath / prompt cache / effort | kronos, multipath, prompt-caching, reasoning-effort tutorials | **off / low / default** | Possible useful primitives — choose on measured need, not all defaults |

Code: `src/server/scout/serv-options.ts`, `plan-parse.ts`, `spend-gate.ts`.

## 5. Inventory honesty

- **Replay path:** only fixtures that actually exist (cite path + capture time). Current real-source replay: `fixtures/autodev-camry.json` (Auto.dev listings payload; `createdAt` fields on rows e.g. `2026-09-16…`; fixture used in-repo as offline proof).
- **Live path:** Auto.dev via existing client + monthly stop; default `maxProviderCalls=0` so live path does not run in this PR.
- **Empty vs unavailable:** distinguish `inventory_empty` (honest zero) from `provider_unavailable` / `listings_unconfigured` / timeout.
- Synthetic/adversarial unit fixtures must be labeled **NOT live evidence**.

## 6. Evaluation harness

Baseline vs scout on the **same** candidate pool and budget. Held-out / tuning separate. All losses visible. Mock SERV plans prove control plumbing only — never efficacy. No live paid model efficacy until owner approves. Report proposed outcomes, not fabricated scores.

## 7. Brand / presentation

Preserve approved Lemonless brand (Orbitron wordmark + animated mark). Scout UI (if any later) follows existing product chrome; this slice prioritizes domain/API substance. Design/creative naming for scout surfaces should stay Lemonless-native (“Scout”, “Investigation candidates”) without inventing a second brand.

## 8. Acceptance (this PR)

- Design + plan committed under `docs/superpowers/`.
- Working bounded-loop code with offline proof tests (replay + synthetic).
- OpenServ SDK adapter with type-level / unit verification; local ≠ deployed.
- API behind default-OFF flag + access/cost guards.
- PR53 merge conflicts resolved non-destructively; branding preserved.
- No spend in CI/agent run; no force-push; scout not auto-merged/deployed as live.
