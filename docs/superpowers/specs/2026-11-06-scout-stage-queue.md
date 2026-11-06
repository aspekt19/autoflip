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

## STAGE3-RESIDUE-FOLLOWON-V5 — PIN TO_REPLACE (cite-bound rationale + grounded persist)

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

## Ops

Console ~$24.16 visible — no max-cost/reserve verified. **NO paid calls this unit** (parent
stream owns spend). No Graph/merge/deploy/secrets/model settings. Branding retained.
