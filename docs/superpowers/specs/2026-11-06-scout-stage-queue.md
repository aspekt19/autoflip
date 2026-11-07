# Scout / Find review stages — queue (do not silently drop)

writtenAt_utc: 2026-11-06
constraints: no spend / secrets / deploy / merge / Graph / model change. No self-release approval.

## STAGE1 — PIN d8187b8 (confirmed)

Durable monthly seed, non-numeric reject, env-balance≠grant, 0-budget 0-fetch, cache DECR,
per-make ceiling, no HTTP-injected grant. Follow-on: `/find` shared-store (`494e771`).

## STAGE1B — PIN ad5f9f7 (confirmed)

Durable NX claim before work / no TTL; overlap one execution / 409 / replay; owners isolated;
mandate conflict; serverless Memory block; mid-flight abort+timeout reservation retained.
Hash: stripped mandate + planner + preferLive (spend fields stripped).

## STAGE1B-RECOVERY — PIN 36a56b9 (confirmed landed)

Bind applied then error → replay; no foreign leak; no re-run.

## STAGE1B-RECOVERY-FOLLOWON — THIS residue (a) with Stage2A residue (b)

1. **Live overlap false-dead:** mid-run peer → non-terminal `in_progress` (not falsely dead
   `recovery_needed`). No heartbeat / No TTL reclaim.
2. **`saveScoutRun` durable ack:** fail → `idempotency_persist_failure` / no SUCCESS / claim
   stays `in_progress` without runId; no re-exec.

## STAGE2A — PIN 680b59a (confirmed)

Directions / first-failure-continue / geo v2 / session v2 / economics-unknown / memory backend.

## STAGE2A-FOLLOWON — PIN 3a6f90b (confirmed; ledger closed)

304 tests/tsc/build; REAL shared monthly ledger (899→200+429, key 900, one stub fetch,
memory counters 0); cache-hit no-charge; pure failure statuses; shared-store copy; strict named
skip; preferLive hash. **Do not rewrite ledger.**

## STAGE2A-FOLLOWON-RESIDUE — THIS residue (b) with recovery-followon (a)

Mixed zero-rows → `incomplete_search` (not empty-market / loosen-filter); searchedModels =
successfully checked; failedModels = attempted-not-checked; UI labels both. Ledger untouched.

## STAGE2B — PIN dac59b3 (confirmed 317 tests; PRODUCT not release closure)

Confirmed: adversarial missing-price rejected / overpriced replaced / distinct peer actually
investigated; unknown history withholds; title forbid; claimsSafeBuy false; unsupported gov
replay no-charge tool counts; empty replacement abstain; real recentOutcomes transport.

**Remain PRODUCT gap — do not market 2B as full goal / autonomy:**
- `inventory.search` (~672–689) cannot call adapter again / change make·zip·radius
- heuristic (~969+) still VIN-walk except unsupported/failed/replace-empty
- `recentOutcomes` status+summary ≠ enough evidence facts; evidenceHints limited/investigated
- Unknown or unsupported tool alone is **not** proof the car is bad — do not force replacement
  merely because a gov tool is unavailable

## STAGE3 — PIN ce19f9f (base)

Honest scout-metrics/v1 observables + perturbation detectors. MOCK/OFFLINE plumbing only —
not SERV efficacy. Independent review found observation gaps → Stage3-residue below.

## STAGE3-RESIDUE — PIN af5a921 (scout-metrics/v2)

Independent review of ce19f9f found observation gaps; residue remediates without claiming
metrics closure from test counts (328/335 green ≠ closure). Schema **scout-metrics/v2**:
1. historyUnknownEvaluated vs historyNeverEvaluated (default pending ≠ measured)
2. titleBrandForbidOrWithhold typed via safety_red_flags — not data_sufficiency history
3. structured tool `capability` — unsupported_as_success not summary-regex
4. fake_replacement requires acquiredVin in pool/lifecycle
5. structured inventoryIdentity (kind+isFixture) consistency
6. requireInventorySearch default ON; empty maps/attempts → **unknown** not 0
7. missing usage/budgets → unknown; wallMs = settled wallEndedAtMs − start
8. typed select/reject/replace counts (not provenance substring)
9. denominator: completed + refusal + timeout + abstain + parse; safetyCertified always false;
   exit0 = plumbingOk only

## STAGE3-RESIDUE-FOLLOWON — PIN 32b4ac5 (scout-metrics/v3)

Independent review of af5a921 found remaining observation gaps; v3 remediates without closure:
1. capability required + capabilityGrounded independent contract (status-derived = incomplete)
2. GHOST pending/rejected pool row ≠ success replace lifecycle (fake_replacement)
3. inventoryIdentity.sourceEvidence / fixtureEvidence — unverifiable ≠ clean self-attestation
4. traceComplete vs decisionEvidenceComplete (timeout/refusal/parse not decision-certified)
5. action tool counts vs disposition counts exposed; disagreement flag (no Math.max hide)
Keep 7-case denominator / settled wall / MOCK_OFFLINE not SERV efficacy.

## STAGE3-RESIDUE-FOLLOWON-V4 — PIN 2c5d1cf (disposition / constraint / metrics)

Independent review of 32b4ac5 remaining substantive gaps; bounded remediations (not closure):
1. unsupported-gov-only reject/replace blocked after listing.normalize — structured
   rationaleKind + adverse evidence; unknown-title safety_red_flags forbid ≠ adverse;
   legitimate adverse reject + uncertainty_progress replace/abstain preserved
2. CandidateConstraintQualification per-field pass/fail/unknown with origin; unknown
   fields remain investigation candidates (not verified hard-constraint matches);
   known overcaps still excluded; no invented ZIP distance
3. metrics: GHOST pending never-eval = fake_replacement; replaceAcquired survives
   later select; lifecycleContradiction vs benign actionCountDisagreement;
   trustBoundary capability=runner_declared / inventorySource=listing_source —
   declaration only, not buyer-safety certification
Keep closed from prior: query params/known-cap filter, fresh briefs, per-candidate
origin, partial-on-failure, preadapter budget, nationwide mandate, no paid unlock.
355 tests + plumbingOk ≠ SERV efficacy / production superiority.

## STAGE3-RESIDUE-FOLLOWON-V5 — PIN 18f7743 (cite-bound rationale + grounded persist)

Independent review of 2c5d1cf rationale integrity holes; bounded correction (not closure):
1. adverse_evidence must cite matching structured facts (citedEvidence) — incidental
   economics_estimate / mandate forbid does not unlock arbitrary gov-bad reason text;
   economics_estimate requires assumptionsDisclosed; endorsed groundedReason from cites
2. uncertainty_progress replace persists dispositionRationale + grounded rejectReason
   across candidate/provenance/tool summary/API/UI; plannerReasonRaw audit-only
Retain planner action choice; no keyword-gate of reason text; no blanket ban of estimates.
Prior closed items hold. 358 tests + plumbingOk ≠ SERV efficacy / production superiority.

## STAGE2C — PIN 6e8e655 (bounded mid-loop search; PRODUCT not efficacy)

Real bounded search adjustment within mandate/server caps:
- typed validated search params → fresh results / duplicates / source / geo
- provider + fixture adapters with budget spies (prove actual adapter dispatch with stubs;
  hosted SERV probe = parent only)
- richer bounded facts / missingness / gates / confidence into SERV prompt so feedback can
  choose useful next check / reject / replace / **new search** — not blind VIN-walk
- risk/evidence-directed choices without inventing history data
- No fake autonomy claim; no paid Auto.dev / new expenses this unit
- autonomyClaim=none; mocked equal-data eval ≠ SERV efficacy

## STAGE2C-FOLLOWON — PIN f0354af (product; separate from metrics v3)

Independent review of 6e8e655 product gaps 1–7:
1. explicit distanceMiles:null nationwide semantics (no ?? collapse)
2. typed maxPriceUsd/maxMiles at query + ingestion; live URL model/price/miles/radius;
   unknown geo ≠ out-of-range; asking-not-sold
3. newlyAcquired briefs; flip-excluded → rejected lifecycle (not infinite pending)
4. unsupported-gov-alone reject forbidden; other-fact reject/abstain still allowed
5. per-search/per-candidate inventory origins; initial identity not overwritten
6. failed mid-loop search → partial even with candidates
7. provider budget exhausted → reject_no_provider_spend pre-dispatch (tool slot still consumed)

**Remain (do not market closed):** heuristic VIN-walk when search not chosen; no Guard/advantage;
347 green ≠ closure; mocked eval ≠ SERV efficacy.

## STAGE-INTEGRATION — PIN 8a66dcd (HTTP→facade→stubbed SERV/Auto.dev)

Bounded offline integration (not live E2E, not SERV efficacy):
- Routes: `GET /api/scout`, `POST /api/scout` (`postScoutStart`), persistence via
  `GET /api/scout/:runId` store; UI page `GET /scout` behind `SCOUT_UI_ENABLED`
- Path proven: HTTP entry → `executeScoutRun` → `executeScoutSafely` →
  `servScoutPlanner` **real** `scout_plan` request serialization (stub remote) →
  live inventory adapter with stub fetch → reject/replace/search → Kv persist /
  Idempotency-Key replay → consumer JSON (`presentation`, `dispositionRationale`)
- Mandates covered: flip multi-make local, personal nationwide empty/abstain,
  fixture offline heuristic; production POST without harness cannot open live
- Wiring fixes: `servScoutPlanner` honors caller `config`/`env`/`fetch` (no silent
  process.env mismatch); hooks env reaches facade when harness omitted
- Labels: OFFLINE; stubbed SERV ≠ live reasoning; testAuthority harness-only

## STAGE-INTEGRATION-BUILD — PIN f820be9 (Next route export boundary)

Independent review of 8a66dcd: `postScoutStart` exported from `app/api/scout/route.ts`
broke `next build` / generated route types (invalid Route field). Bounded fix:
- Handler lives in `src/server/scout/http-start.ts`; route exports only `GET`/`POST`/`runtime`
- `/scout` `dynamic = "force-dynamic"` so `SCOUT_UI_ENABLED` is runtime, not build-bake
- Regression tests forbid non-allowlisted route exports; production `POST` is unary
  (no client `testAuthority`/harness/env-grant bypass)
- Verified: `npx tsc --noEmit` exit 0; `npm run build` exit 0; offline `next start`
  smoke GET `/api/scout` + `/scout` flag off/on (HTML source inspection — not browser E2E)

## STAGE-OWNER-LIVE — PIN (pending tip) owner allowlist + Upstash authority

Reversible repository work so owner can eventually test **production** with an arbitrary
mandate (not curated demo). Offline browser E2E at b454869 remains complete for fixture only.

**Implemented (this pin):**
- `SCOUT_OWNER_USER_IDS` allowlist (af_ userIds) — PR54 Auth.js **not** required; existing keys suffice
- Persistent `verified_account_source` from allowlist + Upstash monthly Autodev remaining +
  `SCOUT_MAX_PROVIDER_CALLS_HARD_CEILING` (+ optional `SCOUT_OWNER_MAX_PROVIDER_CALLS_PER_RUN`)
  — **never** from `SCOUT_SERVER_VERIFIED_BALANCE_USD` / client attestation
- `preferLive=true` fail-closed: no Camry fixture substituted as live (`presentation.kind=live_blocked`)
- Distributed per-owner concurrency lock (`scout:run-lock:{userId}`)
- GET `/api/scout` capabilities (+ optional Bearer for `canPreferLive` / `canUseServPlanner`)
- `/scout` UI: arbitrary makes/ZIP/distance/budget + prefer-live/SERV only when capabilities allow
- Defaults remain OFF; Scout still not in primary header nav

**Env NAMES only (values set in host — not by this agent):**
`SCOUT_ENABLED`, `SCOUT_UI_ENABLED`, `SCOUT_PAID_EXECUTION`,
`SCOUT_MAX_PROVIDER_CALLS_HARD_CEILING`, `SCOUT_OWNER_USER_IDS`,
`SCOUT_OWNER_MAX_PROVIDER_CALLS_PER_RUN`, `SCOUT_ALLOW_SERV_PLANNER`,
`AUTODEV_API_KEY`, `SERV_API_KEY`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`

**Still impossible without external configuration / spend authorization:**
- Real Auto.dev listings (no Auto.dev spend authorized in cloud runs; key+authority on host)
- Live SERV planner series (credits exist centrally; sequential series not spent here)
- Production flag enable / deploy / merge / Graph / Agent.process
- PR54 Auth.js (optional; orthogonal package.json/globals.css overlap only)

## STAGE-BROWSER-E2E — PIN b454869 (compiled local next start clickthrough)

Real Chromium render/clickthrough of compiled PR59 (not HTML-substring / helper-only;
not box checkout; not deploy). Tip builds on `f820be9` / docs `95695de`.
- UX honesty: client `af_` validation; partial as warn; surface run id; selecting stamp
  uses offline/non-SERV wording when `autonomyClaim=none`
- Flows: `/scout` UI off gate; UI on desktop+mobile; empty-key validation; offline
  fixture run → constraints (`hardConstraintVerified=false`, geo unknown) / provenance /
  no efficacy claims; progress offline stamp; console clean; network localhost-only
- Persist: `GET /api/scout/:runId` refresh works; UI has **no** resume/replay control
  (run id display only)
- Gates: `tsc` 0; `next build` 0; vitest offline scout suite 18 pass
- Artifacts: `/opt/cursor/artifacts/scout-desktop-results-b454869.png`,
  `scout-mobile-results-b454869.png`, `scout-desktop-ui-off.png`,
  `scout-browser-clickthrough.mp4`, `scout-qa-report.md`
- Labels: OFFLINE; no paid SERV/Auto.dev; no production flag enable; no Graph/merge/deploy

### Release-readiness blockers (precise; not closed by this pin)

| Area | Status |
|------|--------|
| `SCOUT_ENABLED` / `SCOUT_UI_ENABLED` | Default **off**. UI ≠ API; UI alone does not enable POST. |
| Header nav | `/scout` **not** in primary Header (internal/opt-in page only). Live branding (Orbitron wordmark PRs 55–58 on main) untouched by Scout CSS append in `globals.css`. |
| Auth PR54 | Still **open** — durable Auth.js ownership not merged. Scout today uses `af_` API keys via `agentAccount`; no NextAuth session gate on `/api/scout`. Overlap files: `package.json` / `globals.css` (additive scout styles vs PR54 auth styles) — merge carefully, no brand overwrite intended. |
| Live Auto.dev / SERV | Non-bypassably blocked without non-env `PaidSpendAuthority`. Env balance/cap strings are **not** a grant. No verified account spend source wired for production. |
| `SCOUT_ALLOW_SERV_PLANNER` + paid + Upstash | Required for live planner; production HTTP never passes `testAuthority`. |
| Hosted / runtime | Upstash distributed Kv required for paid path; Memory/File insufficient. No deploy/secrets/Graph/`Agent.process` in this unit. |
| Efficacy | Integration + unit counts ≠ buyer-safety / SERV efficacy / production superiority. |

## Ops

Console ~$24.16 visible — no max-cost/reserve verified. **NO paid calls this unit** (parent
stream owns spend). No Graph/merge/deploy/secrets/model settings. Branding retained.
