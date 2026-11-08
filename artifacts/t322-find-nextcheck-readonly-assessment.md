# T322 — Find next-check READ-ONLY assessment (PR79 / main `73e9f229`)

**Scope:** Read-only code assessment at published main `73e9f22904cbe8d4f9f5d6286ac427ea612e0ac1` (PR #79 merge). No code changes, no merge, no env writes, no hosted calls in this assessment run.

**Live parent evidence (accepted as given):** home SUV ~$20k scenario1 → 16 real feed cards / 3 models; settled `SERV chose compare_observed_asks … [unchanged_state]`; no fallback/diag/ENV_DRIFT; no automatic rematch/replan; credit 1 preserved; CR-V Honda label fixed; Mini spend consistent; proves one SERV choice, not full tool checks or useful repeated cycle. Fable EXCLUDED.

---

## 1. Profile env mapping — Sonnet vs GPT-5.6 Sol for **real product Find next-check**

### Exact keys (do not assume Scout override affects Find)

| Profile id | Env key | Used by |
|---|---|---|
| `scout_plan` | `SERV_PROFILE_MODEL_SCOUT_PLAN` | Scout planner only (`runServ("scout_plan")` via Scout paid/safe-execute / compare harness). **Does not** drive Find next-check. |
| `find_next_check` | `SERV_PROFILE_MODEL_FIND_NEXT_CHECK` | Find product next-check: `POST /api/find/next-check` → orchestrator → `runFindNextCheckLive` → `runServ("find_next_check", …)`. |
| `need_extract` | `SERV_PROFILE_MODEL_NEED_EXTRACT` | `/api/need` / understandNeed only — separate from next-check chooser. |
| *(global)* | `SERV_MODEL` | Passed as `deps.model` / `requested` from `runtimeDeps()`; **beaten by** per-profile env. |
| *(escape)* | `SERV_PROFILE_MODEL_ALLOW_UNLISTED=1` | Allows non-candidate ids after Flip console validation; fail-closed otherwise. |

Evidence:

- Env key formula `SERV_PROFILE_MODEL_${id.toUpperCase()}` → Find key is literally **`SERV_PROFILE_MODEL_FIND_NEXT_CHECK`**, not SCOUT_PLAN (`src/server/serv/profile-models.ts:79-81`, `:107`, `:137-140`).
- Priority: profile env → caller `requested` (`SERV_MODEL`) → `BASE_MODEL` (`profile-models.ts:137-140`).
- `runServ` always resolves via `resolveProfileBaseModel(id, { requested: deps.model, env })` (`src/server/serv/run.ts:448-453`).
- Find wiring: route passes `env: process.env` + `servModel: deps.servModel` (`src/app/api/find/next-check/route.ts` + `src/server/deps.ts:15-20`); live calls `runServ("find_next_check", …)` (`src/server/find-next-check-live.ts:182-191`).
- Scout wiring remains on `scout_plan` + `SERV_PROFILE_MODEL_SCOUT_PLAN` (tests assert Sonnet beats global Mini: `src/server/serv/profile-models.test.ts:15-19`; Flip shortlist tests set `SERV_PROFILE_MODEL_SCOUT_PLAN` vs `SERV_PROFILE_MODEL_FIND_NEXT_CHECK` separately: `src/server/serv/flip-decision-shortlist.test.ts:33-42`).

**Verdict:** Setting `SERV_PROFILE_MODEL_SCOUT_PLAN` alone **cannot** change Find next-check model. For a Find product comparison, parent must set **`SERV_PROFILE_MODEL_FIND_NEXT_CHECK`**.

### Current defaults + allowlists

| Item | Current default / allowlist |
|---|---|
| Production base | `BASE_MODEL = "gpt-5.4-mini"` (`src/server/serv/profiles.ts:17`) |
| `find_next_check` timeout | `25_000` ms (`profiles.ts:586`) |
| `scout_plan` timeout | `45_000` ms (`profiles.ts:414`) — Scout only |
| `find_next_check` fallback | `deterministic_fallback` (`profiles.ts:588`) |
| `find_next_check` candidate models | `gpt-5.4-mini`, `claude-sonnet-5.5`, `claude-sonnet-4.6`, `gpt-5.6-sol`, `claude-fable-5`, `gpt-6.1-sol`, `claude-opus-5.5` (`profile-models.ts:37-45`) |
| `scout_plan` candidates | same set **plus** `gemini-2.5-flash`, `gemini-3.1-pro-preview` (`profile-models.ts:26-36`) |
| Flip paid shortlist (order) | `claude-sonnet-5.5` → `gpt-5.6-sol` (`src/server/serv/flip-decision-shortlist.ts:33-62`, `:70-72`) |
| Flip EXCLUDED | `claude-fable-5` (`flip-decision-shortlist.ts:64-65`) |
| Check-id allowlist (schema + domain) | `clarify_year_band`, `clarify_miles_cap`, `set_budget`, `compare_observed_asks`, `run_full_analysis`, `get_history_report`, `widen_or_nationwide` (`profiles.ts:611-619`; `src/domain/find-next-checks.ts:9-18`) |
| Proposed-check cap | max **4** from code order (`find-next-checks.ts:127-132`) |
| Shared transport env | `SERV_API_KEY`, optional `SERV_BASE_URL`, optional `SERV_MAX_OUTPUT_TOKENS` (default 4096; min 256; max 16384) (`src/server/serv/output-tokens.ts:12-46`) |

### Safe reversible comparison plan (parent writes env if chosen — no secrets)

1. Leave `BASE_MODEL` / unset global `SERV_MODEL` as production Mini path.
2. **Do not** set `SERV_PROFILE_MODEL_SCOUT_PLAN` for this Find comparison.
3. Arm Find only: `SERV_PROFILE_MODEL_FIND_NEXT_CHECK=claude-sonnet-5.5` on the **same** Vercel deployment that serves `/api/match` + `/api/find/next-check`.
4. Replay same scenario1 need → capture next-check response fields (chosenId, loop.reason, source, proofs.modelRequested/modelReported, failureDiag).
5. Switch to `SERV_PROFILE_MODEL_FIND_NEXT_CHECK=gpt-5.6-sol`; repeat same recorded inputs (see §3).
6. Revert: **unset** `SERV_PROFILE_MODEL_FIND_NEXT_CHECK` → code falls back to Mini (`profile-models.ts:140`).
7. Keep Fable out of paid/production selection per `SERV_FLIP_EXCLUDED_FROM_PAID`.

---

## 2. Why this stop: `compare_observed_asks` (`research: false`) → `[unchanged_state]`

### Causal chain (code)

1. **Allowlist includes compare** when `observedModelCount >= 2` (`find-next-checks.ts:84-90`). With 3 models / 16 cards, compare is proposed. Soft gap `history` (regex includes “hidden problems”) and/or `conditionPriority` also propose `get_history_report` (`find-next-checks.ts:100-115`; history text: `src/domain/need.ts:677-687`). Cap 4 keeps compare **ahead of** history/full-analysis in stable id order (`find-next-checks.ts:9-17`, `:127-132`).

2. **SERV may honestly pick compare.** Profile system text simultaneously prefers history/full-analysis *when condition/history/EPA needed* **and** prefer compare when multiple models appear (`profiles.ts:593-594`). Live evidence: autonomous SERV chose `compare_observed_asks` (not fallback).

3. **Apply is presentation-only.** `applyFindNextCheck(..., "compare_observed_asks")` returns unchanged need/refine and **`research: false`** with note that condition stays unknown / fuel unavailable without EPA match (`src/domain/find-path.ts:138-145`).

4. **No rematch.** Orchestrator rematches only when `live.research && deps.runMatch` (`find-next-check-orchestrator.ts:286-306`). With `research: false`, listings stay identical.

5. **Loop stop reason is `unchanged_state`.** `decideFindNextCheckLoop` checks need/listings fingerprints first; if unchanged → stop `unchanged_state` (`find-next-check-loop.ts:149-158`). The later `compare_observed_asks` + `!research` → `grounded_stop` branch (`:161-171`) is **unreachable** on this path because compare never changes context. UI auto-continue requires `loop.continue` (`find-next-check-ui.ts:21-29`) → false.

6. **VIN / history / credit paths are not auto-executed.** `run_full_analysis` / `get_history_report` are `USER_ACTION_STOP` (`find-next-check-loop.ts:84-87`, `:141-147`). Even if SERV had chosen them: apply still `research: false` (history only flips `conditionPriority` when previously `unspecified`; full analysis is a note only) (`find-path.ts:147-166`) — still no rematch, no free gov tool dispatch, no credit debit on next-check route (`route.ts` header comment; claim spend is SERV HTTP accounting only).

### Intended honest stop vs objective product gap

| Classification | What |
|---|---|
| **Intended honest stop** | Do not invent condition/history/TCO; do not auto-spend report credit; do not rematch when need/listings unchanged; stop auto-loop without a hidden step quota; surface observed median compare + unknowns. Matches live: credit preserved, no rematch, honest unknowns on shortlist. |
| **Objective product gap** | Find next-check **cannot** perform Scout-style free vehicle tool checks (`evidence.gov_recalls` / `gov_vpic` / `gov_safety`). Those tools exist only on `scout_plan` schema (`profiles.ts:421-422`, `:474-481`). “Hidden problems” / condition priority therefore stop at **median compare + manual user-action pointers**, not at VIN-level free evidence. Competing profile prefs can select compare before history/full-analysis even when history soft-gap is present. Label quirk: stop reason is `unchanged_state` rather than the compare-specific `grounded_stop` because of check order. |

**Do not force fake cycles:** inventing rematch or auto-running paid full analysis would violate current honesty gates.

---

## 3. Same-input eval capture — minimum shared REAL recorded inputs

### What Find already captures server-side

`FindSearchContextRecord` (KV, TTL 2h) minted by `/api/match` (`src/server/find-search-context.ts:16-34`, `:40-69`; mint in `src/app/api/match/route.ts:54-65`):

- `searchContextToken` (opaque owner-bound)
- `userId`
- **`need`: full `StructuredNeed`**
- **`refine`**
- **`listings[]`**: `make`, `model`, `year`, `priceUsd`, `miles`, optional `vin` (from match directions; unusable asks nulled) (`find-search-context.ts:57-64`, `:149-174`)
- `appliedCheckIds[]`
- `servNextCheckEnabled` (mint-time key presence)
- `iat` / `exp`

After next-check: context updated with needAfter / listingsAfter / applied ids (`orchestrator.ts:308-313`). Keyed path also stores claim receipt `resultJson` (public result subset) + spend log `{ profile: "find_next_check", httpAttempts, source, at }` (`find-next-check-claim.ts:179-200`; `orchestrator.ts:157-185`).

### Minimum shared corpus for same-inputs eval (no future invention)

For model A vs B on the **same** Find next-check decision, persist/export:

1. Minted **search context** (`need` + `refine` + `listings` + `appliedCheckIds` at decision time).
2. Recomputed **facts blob** actually sent to SERV (`find-next-check-live.ts:152-172`): `allowedChecks`, counts, `softGapIds`, budget/year/miles/conditionPriority/zipPresent/emptyInventory, screened `shopperNote`.
3. **Outcome record:** `source`, `chosenId`, `servNote`, `research`, `loop.{continue,reason}`, `compare`, `shortlist`, `failureDiag` (category/reasonCode/refusalFieldBytes/usagePresent only), `keyedAutonomyDiag`, `proofs[].modelRequested|modelReported|latencyMs|fallbackUsed` (no API keys, no raw refusal prose).
4. Fixed **profile config stamp:** profile id `find_next_check`, env key used, base/effective model id, timeoutMs=25000, transport policy.

Reconstructable offline: `proposeFindNextChecks` + `applyFindNextCheck` + `decideFindNextCheckLoop` are pure given (1)+(3). SERV choice itself must be recorded from the live response (or replayed with same user JSON).

**Gap:** there is no durable “eval fixture” export of the SERV user JSON / choice beyond TTL KV + one-shot API `proofs` / receipt. Parent should snapshot the next-check JSON response + search-context record for scenario1 before comparing Sonnet vs Sol.

---

## 4. Structural reality — Find vs free vehicle tool checks

**Yes: current Find next-check is structurally need clarify + observed median compare (+ widen geography) + user-action pointers — not actual free vehicle tool checks.**

| Capability | Find next-check | Scout `scout_plan` |
|---|---|---|
| Clarify year/miles/budget | Yes (code apply; some rematch) | N/A (mandate/search tools) |
| Median ask/miles/year compare | Yes (`compareObservedModels`) | Different comps tools |
| Free NHTSA/vPIC/NCAP | **No** | Yes (`evidence.gov_*`) |
| Auto VIN investigation loop | **No** | Yes (select/run_tool/reject…) |
| History / full analysis | Pointers only; stop for user/credit | Paid/provider paths separate |
| Credit debit on next-check | **No** | Scout metering separate |

Evidence: Find allowlist ids (`find-next-checks.ts:9-18`); apply research flags (`find-path.ts:116-166`); Scout tool enum (`profiles.ts:474-481`). Orchestrator never passes `fuelsByModelKey`, so ownership fuel stays unavailable on this path (`orchestrator.ts:250-256` vs live optional fuels).

---

## 5. Telemetry — config keys / defaults / profile mapping / safe fields

### Config keys (no secret values)

| Key | Default | Maps to |
|---|---|---|
| `SERV_API_KEY` | unset → keyless deterministic Find | Both `/api/match` mint flag + `/api/find/next-check` keyed path; drift → `ENV_DRIFT` hint (`orchestrator.ts:127-129`) |
| `SERV_BASE_URL` | OpenServ default in `runServ` | All SERV profiles |
| `SERV_MODEL` | unset → Mini via resolve | Global `requested`; beaten by profile env |
| `SERV_PROFILE_MODEL_FIND_NEXT_CHECK` | unset → Mini | **Find next-check only** |
| `SERV_PROFILE_MODEL_SCOUT_PLAN` | unset → Mini | **Scout only** |
| `SERV_PROFILE_MODEL_NEED_EXTRACT` | unset → Mini | `/api/need` only |
| `SERV_PROFILE_MODEL_ALLOW_UNLISTED` | unset/fail-closed | Escape hatch |
| `SERV_MAX_OUTPUT_TOKENS` | 4096 | All chat/responses caps |

### Safe server telemetry fields (already secret-scrubbed)

- **API `failureDiag`:** `category`, `reasonCode`, `refusalFieldBytes`, `usagePresent` — never raw refusal text (`route.ts` response; classifier honesty in `response-failure.ts:180-186`).
- **`keyedAutonomyDiag`:** `keyed`, `mintSaidKeyed`, `autonomousServ`, `source`, `failureCategory`, `failureReasonCode`, `configHint` (hints name env vars, never values) (`orchestrator.ts:72-147`).
- **Spend log:** `profile`, `httpAttempts`, `source`, `at`, token/claim ids — “never stores API keys or raw refusals” (`find-next-check-claim.ts:179-200`).
- **Proofs (client-visible):** `purpose`, `modelRequested`, `modelReported`, `tools`, `features`, `promptGuard`, `latencyMs`, `fallbackUsed`, `jsonSchema`, `codeComputed`, optional `openserv.usage`/`finish_reason`/`model` — built without embedding refusal prose as proof text (`proof.ts:126-146`; run path strips refusal into proof text per `run.ts` comments).
- **Loop:** `continue`, `reason`, `detail` (`find-next-check-loop.ts:35-39`).

---

## Bottom line for parent

1. **Find model compare env = `SERV_PROFILE_MODEL_FIND_NEXT_CHECK`** (Sonnet 5.5 ↔ gpt-5.6-sol). `SERV_PROFILE_MODEL_SCOUT_PLAN` is Scout-only.
2. Scenario1 stop is an **honest non-research stop** after one allowlisted SERV choice; reason `[unchanged_state]` is structurally expected for `compare_observed_asks`. The **product gap** is absence of Find free VIN/gov tool execution — not a missing rematch bug.
3. Same-input eval needs a snapshot of **searchContext (need+listings) + next-check response/facts**; KV alone is TTL-bound.
4. Find next-check is **not** Scout free-gov investigation.
5. Telemetry keys/fields above are sufficient for gated model compare without logging secrets.
