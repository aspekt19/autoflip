# SERV boundary audit — Find path

**Scope:** `/find` UI (`AssistantFlow`), `/api/need`, `/api/match`, `/api/find/decide`, find-agent loop/tools, `understand-need`, `find-match`, `search-spec`, `find-decide-orchestrator`, eval/live Find.

**Goal architecture (reminder):**
- SERV gets raw user words + **only** user-explicitly-set fields (tagged). No defaults as constraints.
- SERV owns search / re-search / relax / choose / nothing-fits.
- `search_listings` = thin proxy: unfiltered results + funnel; no code filters / caps / early exits.
- Code after SERV: validate listing ∈ results, VIN / price / mileage, budget, math only; else repair to SERV.
- Charge only on chosen car or explained nothing-fits.

**Method:** Grep + read of Find surfaces on branch `cursor/serv-boundary-structural-3e9b` (from `origin/main`). Line numbers are approximate; prefer symbols if drift.

**Fate key:**
- `removed` — **target** disposition (SERV / tagged user fields should own it). Not a claim the symbol is already gone unless the main audit Verified table says so.
- `still present` — verified still reachable in production code (honest status).
- `moved into SERV tool param` — keep capability, but as an explicit SERV/tool argument, not a silent code default/filter.
- `kept as guardrail` — post-SERV validation / money math / auth / infra; justification required.

---

## 1. `/find` UI — `AssistantFlow.tsx` / intake

- `src/components/AssistantFlow.tsx:255` — initializes `budgetKnown = true` before any note parse — proposed fate: **removed** (treat unknown until tagged dirty/form or note extract).
- `src/components/AssistantFlow.tsx:464-466` — on fresh note, forces `budgetUsd/budgetKnown/budgetDirty` null/false even if form holds leftover numbers — proposed fate: **kept as guardrail** (prevents stale form beating note; aligns with tagged dirty-only).
- `src/components/AssistantFlow.tsx:428-430` — fresh note omits ZIP/radius so server resolves from note — proposed fate: **kept as guardrail** (avoids stale wizard geo as constraint).
- `src/components/AssistantFlow.tsx:551-556` — UI labels server-applied `NOTE_DEFAULT_RADIUS_WHEN_ZIP` (100 mi) as default — proposed fate: **removed** as constraint path (see intake); label alone OK if radius not sent as hard filter unless user confirms.
- `src/components/AssistantFlow.tsx:1345-1347` — watch-geo draft invents `NOTE_DEFAULT_RADIUS_WHEN_ZIP` when radius missing — proposed fate: **removed** (do not invent radius; leave null / ask).
- `src/components/AssistantFlow.tsx:1358` — Deal Radar handoff defaults `priceMax = 40_000` when budget unknown — proposed fate: **removed** (no invented budget as constraint).
- `src/components/AssistantFlow.tsx:1202` — filters out `source === "sample"` cards client-side — proposed fate: **kept as guardrail** (demo fixture must never present as live inventory).
- `src/components/AssistantFlow.tsx:1058-1060` — blocks Confirm when radius set without ZIP — proposed fate: **kept as guardrail** (geo consistency; not ranking).
- `src/domain/find-intake-stage.ts:102-108` — `attachNoteGeo` applies `NOTE_DEFAULT_RADIUS_WHEN_ZIP` (100) when city/ZIP inferred and no explicit miles — proposed fate: **removed** (default radius becomes hard search constraint without user tag).
- `src/domain/note-intake.ts:13` — `NOTE_DEFAULT_RADIUS_WHEN_ZIP = 100` constant — proposed fate: **removed** as constraint default (UI hint only if kept).
- `src/domain/find-intake-stage.ts:8-11` — `findStageAfterNote` skips budget/follow stages from regex-derived need — proposed fate: **moved into SERV tool param** (stage skipping should follow SERV plan `question`, not code regex alone).
- `src/components/FindIntakeFields.tsx` (budget commit path) — parses/commits budget as dirty form edits — proposed fate: **kept as guardrail** (user-explicit tagged fields).

---

## 2. `/api/need` + `understandNeed` + plan → need

- `src/app/api/need/route.ts:34` — defaults `mode` to `"personal"` when not flip — proposed fate: **kept as guardrail** (product surface default; not a search filter).
- `src/app/api/need/route.ts:38` — defaults `budgetScope` to `"unspecified"` — proposed fate: **kept as guardrail** (neutral tag).
- `src/app/api/need/route.ts:40-48` — passes ZIP/radius/`radiusDirty`/repair/use only when present — proposed fate: **kept as guardrail** (tagged explicit fields).
- `src/app/api/need/route.ts:79-86` — builds `formEdits` only for dirty/typed fields — proposed fate: **kept as guardrail**.
- `src/server/understand-need.ts:98-107` — drops form budget unless `budgetDirty` or note has no budget — proposed fate: **kept as guardrail**.
- `src/server/understand-need.ts:131` — `fallbackFindPlan(...)` always seeds plan before/without SERV — proposed fate: **removed** as decision owner (offline fallback OK for availability, but must not invent hard constraints/models as if SERV planned).
- `src/server/understand-need.ts:164-168` — SERV `find_plan` user payload includes `formOverrides` + note — proposed fate: **kept as guardrail** if overrides are dirty-only; ensure undirty leftovers never appear.
- `src/server/understand-need.ts:238` — `validateFindPlan` clamps invented quotes/numbers/models — proposed fate: **kept as guardrail** (grounding); **moved into SERV tool param** for repair loop rather than silent drop-and-search.
- `src/server/understand-need.ts:305-310` — `planToStructuredNeed` then `overlayExplicit` then `supplementNeedFromNote` regex re-fill — proposed fate: **removed** for blank SERV fields refilled by regex (`supplementNeedFromNote`); overlay of dirty form **kept as guardrail**.
- `src/server/understand-need.ts:317-327` — drops stale wizard ZIP when note named a city — proposed fate: **kept as guardrail**.
- `src/server/understand-need.ts:331` — `attachNoteGeo(..., { applyDefaultRadius: true })` invents 100 mi — proposed fate: **removed**.
- `src/server/understand-need.ts:337-340` — form radius only applied when `radiusDirty` or finite miles — proposed fate: **kept as guardrail**.
- `src/server/understand-need.ts:363-372` — marks `radiusMi: { dirty: true }` even when distance is null/default — proposed fate: **removed** (null/default must not be tagged dirty hard).
- `src/domain/find-plan.ts:243-261` — `clampModels` allowlists + caps at 6 models; drops unknown — proposed fate: **kept as guardrail** for invented VINs/models; dropping user-named models should repair to SERV not silent drop.
- `src/domain/find-plan.ts:369` — empty bodyStyles → `["any"]` — proposed fate: **kept as guardrail** (neutral).
- `src/domain/find-plan.ts:467-516` — overrides SERV body/directions from note regex; invents body-style-only direction; caps 3 directions — proposed fate: **removed** for inventing directions; **kept as guardrail** for rejecting conflicting invented bodies with repair; cap may be **moved into SERV tool param**.
- `src/domain/find-plan.ts:512-517` — forces fuel → `ev` when note implies EV — proposed fate: **removed** (SERV should set; code may repair-prompt, not override).
- `src/domain/find-plan.ts:557-569` — `useCaseFromPlan` infers family/commute/haul from summary/priorities — proposed fate: **removed** as constraint; OK as display hint only.
- `src/domain/find-plan.ts:650-669` — `planToStructuredNeed` sets `openToOtherMakes` from excludedMakes heuristic — proposed fate: **removed** (can silently hard-filter other makes via `listingWithinNeed`).
- `src/domain/find-plan.ts:674-723` — `planToDirections` injects open year bounds 1990…nextYear and budget `yearBandForBudget` into direction years — proposed fate: **removed** as provider year constraints when buyer unset (ranking preference must not become query years).
- `src/domain/find-plan.ts:730-871` — `fallbackFindPlan` invents models from `FALLBACK_MODELS` catalog for make-only notes; hybrid fuel from regex — proposed fate: **removed** (catalog invent = code chooses cars).
- `src/domain/need.ts:1097-1112` — `supplementNeedFromNote` fills blank budget/years/miles/zip from regex — proposed fate: **removed** when SERV already planned; **moved into SERV tool param** as note-grounding evidence only.
- `src/domain/need.ts:1145-1190` — `yearBandForBudget` invents yearMin/yearMax from budget tiers — proposed fate: **removed** as hard/search constraint (ranking hint at most).
- `src/domain/need.ts:282-284` — `validateNeed` clamps budget to 1000–250000 — proposed fate: **kept as guardrail** (math/range).
- `src/domain/need.ts:41` / `:192-196` — `MAX_DISTANCE_MILES = 3000` reject — proposed fate: **kept as guardrail**.
- `src/domain/need.ts:484-485` / `src/domain/budget.ts:22-26` — ±10% “around” copy + 5% slight-over admit — proposed fate: **kept as guardrail** for budget math labeling; ensure soft admit is not silent hard raise of max.
- `src/domain/need.ts:724-736` — `listingWithinNeed` hard-filters preferred makes when `openToOtherMakes` false, milesMax, body — proposed fate: **removed** from pre-SERV inventory path; **kept as guardrail** only when validating a SERV pick against tagged user hard limits.

---

## 3. `search-spec` (hard/soft builder + enforce)

- `src/domain/search-spec.ts:150-159` — `hardPrice` always enforces price from form/SERV/note — proposed fate: **kept as guardrail** when source is tagged user/SERV; note-regex fill without SERV miss should not invent.
- `src/domain/search-spec.ts:183-215` — year/miles hard from form > SERV > note regex — proposed fate: **removed** for note-regex when SERV present and left null; dirty form + SERV required **kept**.
- `src/domain/search-spec.ts:228-231` — radius hard only if `form.radiusMi.dirty` — proposed fate: **kept as guardrail** (but callers currently mark dirty too eagerly — see need route).
- `src/domain/search-spec.ts:274-278` — AWD hard/soft from `awdLimitFromText` when SERV drivetrain missing — proposed fate: **removed** (regex must not create hard drivetrain).
- `src/domain/search-spec.ts:291-295` — `titleClean` from note history regex — proposed fate: **kept as guardrail** (safety/money-adjacent title) **or** moved to SERV strength; today code-owned.
- `src/domain/search-spec.ts:297-306` — caps SERV models to 6 queries; invents body-only or `{}` query — proposed fate: **moved into SERV tool param** (query set); empty-query fallback **removed** as silent invent.
- `src/domain/search-spec.ts:343-345` — soft.models source `"default"` when empty — proposed fate: **removed** naming; empty means none.
- `src/domain/search-spec.ts` (`enforceHard`) — drops price/year/miles/radius/make/accidents/drivetrain/body — **removed** as pre-SERV match funnel (verified: `find-match` / agent tools do not call it); symbol may remain for tests / post-SERV validation — **kept as guardrail** only when validating SERV-chosen listing against tagged hard fields.
- `src/domain/search-spec.ts:425-439` — `providerYearQuery` expands min-only into open range through next year — proposed fate: **moved into SERV tool param** (SERV chooses yearRange); code must not invent openMax as constraint without tag.

---

## 4. `/api/match` + `runFindMatch` (code search path)

- `src/app/api/match/route.ts:106-114` — credits gate before provider — proposed fate: **kept as guardrail** (auth/billing infra).
- `src/app/api/match/route.ts:303-327` — charges when `findDeliveryChargesCredit` (queries>0 and listings>0) — proposed fate: **removed** relative to goal (“charge only on chosen car or explained nothing-fits”); today’s charge-on-any-cards is a product-boundary defect vs goal.
- `src/domain/find-delivery.ts:18-23` — charge iff ok + queries + listingCount — proposed fate: **removed** / replace with choose-or-nothing-fits gate.
- `src/app/api/match/route.ts:405-421` — rebuilds SearchSpec marking all need fields dirty — proposed fate: **removed** dirty inflation; only user-tagged edits.
- `src/server/find-match.ts:49-50` — `FIND_MAX_PROVIDER_QUERIES = 6` hard ceiling — proposed fate: **moved into SERV tool param** (infra cap may remain as soft budget with honesty, not silent model skip as “decision”).
- `src/server/find-match.ts:52-89` — `personalRankScores` via `selectBestDealOnEvidence` ranks personal inventory before decide — proposed fate: **removed** (SERV owns choose); display sort only if explicitly non-decisive.
- `src/server/find-match.ts:218-230` — `budgetOnlyDirection` invents yearMin/yearMax from now when unset — proposed fate: **removed**.
- `src/server/find-match.ts:209-215` — `bodyStyleForQuery` drops SUV body for compact model names — proposed fate: **removed** (SERV/tool owns body param).
- `src/server/find-match.ts:234-253` — VIN-decode fill for hard AWD (cap 8) — proposed fate: **kept as guardrail** for evidence enrichment; must not drop unverified unless tagged required (currently marks unverified).
- `src/server/find-match.ts` (`applyHardGate` + `enforceHard`) — drops inventory rows before SERV — **removed** (verified: passenger hygiene only; no `applyHardGate` / `enforceHard` call).
- `src/server/find-match.ts:293-302` — `withinBudget` / `admitFindListingForBudget` drops missing/untrusted/over — proposed fate: **kept as guardrail** for budget math on shown cards **if** budget tagged; dropping before SERV choose is **removed**.
- `src/server/find-match.ts:370-378` — `proposeDirections` / `broadenStarterDirections` / `broadenOpenDirections` invent editorial model pools — proposed fate: **removed** (SERV owns what to search).
- `src/domain/directions.ts:72-256` — editorial CROSSOVERS/COMPACTS/TRUCKS, MAX_DIRECTIONS, arrange/demote — proposed fate: **removed**.
- `src/domain/directions.ts:199-231` — body filter empty → fallback segment invent — proposed fate: **removed**.
- `src/domain/open-search.ts:97-143` — soft-hybrid / truck pool inject + `openRetryModels` — proposed fate: **removed**.
- `src/domain/starter-search.ts` (`broadenStarterDirections` / `starterRetryModels`) — starter editorial retries — proposed fate: **removed**.
- `src/server/find-match.ts:422` — clamps maxQueries to 6 — proposed fate: **moved into SERV tool param** / honesty budget.
- `src/server/find-match.ts:455-466` — skips remaining models with `budget_exhausted` — proposed fate: **removed** as silent decision; surface to SERV for re-search priority.
- `src/server/find-match.ts:495-546` — provider `priceMax` / `milesMax` / years / radius from need — proposed fate: **moved into SERV tool param** (match path should not own query filters when agent loop exists).
- `src/server/find-match.ts:507-561` — inventory stage time cap aborts in-flight queries — proposed fate: **kept as guardrail** (infra timeout) with honesty; not a ranking decision.
- `src/server/find-match.ts:574-645` — code decides fit-empty → retry compact/open models — proposed fate: **removed** (SERV owns re-search).
- `src/server/find-match.ts:786-801` — `filterInventoryWithWiden` soft-drop + radius widen 100→150→250 on already-fetched rows — proposed fate: **removed** (SERV owns relax).
- `src/domain/inventory-widen.ts:134-233` — `RADIUS_WIDEN_STEPS_MI` + soft-as-hard then drop — proposed fate: **removed**.
- `src/server/find-match.ts:817-845` — sorts by personal score / year / miles / price — proposed fate: **removed** as choose; optional display order **kept** only if non-authoritative.
- `src/server/find-match.ts:894-906` — drops implausible odometer then `diversifyListingsByModel(..., 8)` caps shown cards — proposed fate: **removed** for rank-to-drop/cap (implausible may be **kept as guardrail** with honesty; diversify cap **moved into SERV tool param** or UI pagination only).
- `src/domain/find-model-observe.ts:82-120` — diversify/reorder by model + AWD prefer — proposed fate: **removed** as decide-by-code.
- `src/server/find-match.ts:721-738` — early-exit reject sample fixtures — proposed fate: **kept as guardrail**.
- `src/server/find-match.ts:1033-1051` — hard-fail when zero successful provider responses — proposed fate: **kept as guardrail** (infra emptiness ≠ verdict).
- `src/io/autodev.ts:56` — default provider `limit` 20 — proposed fate: **moved into SERV tool param**.

---

## 5. Find-agent loop + `search_listings` tools

- `src/server/find-agent/loop.ts:242-256` — system prompt injects all `formEdits` as overrides; instructs prefer tight filters / hard budget stay — proposed fate: **kept as guardrail** only if formEdits are dirty-tagged; scrub defaults.
- `src/server/find-decide-orchestrator.ts:217-224` — passes zip/distance/budget/years/miles from need into agent formEdits without dirty tags — proposed fate: **removed** untagged fields; pass only user-explicit.
- `src/server/find-agent/tools.ts:22-23` — `SEARCH_LISTINGS_PRICE_SOFT_FACTOR = 1.05` raises provider + local price ceiling — proposed fate: **removed** (thin proxy must not rewrite SERV priceMax).
- `src/server/find-agent/tools.ts:126-127` — `LISTING_CAP = 12`, `LIMIT_MAX = 20` — proposed fate: **moved into SERV tool param** (infra max OK as validation reject, not silent default decide).
- `src/server/find-agent/tools.ts:166-175` — null limit defaults to 12 — proposed fate: **removed** default; require SERV param or pass-through provider default with funnel only.
- `src/server/find-agent/tools.ts:475-502` — `toListingQuery` builds yearRange/priceRange/milesRange/radius/limit and soft price×1.05 — proposed fate: **moved into SERV tool param**; proxy should pass args through, not invent open year bounds (`1980-` / `-2100`).
- `src/server/find-agent/tools.ts:532-583` — `applySearchListingsFunnel` **filters** VIN/YMM, passenger, transmission, body, price, miles, radius, fuel, drivetrain — proposed fate: **removed** as dropping filters (goal: unfiltered results + funnel counts). Funnel **counts** may be **kept** if they do not drop rows returned to SERV.
- `src/server/find-agent/tools.ts:586-628` — `relaxHintsFromFunnel` suggests omit_body/widen/raise — proposed fate: **moved into SERV tool param** (hints OK as non-binding metadata; must not auto-relax in code).
- `src/server/find-agent/tools.ts:715-718` — applies funnel filter then `capListingCards` — proposed fate: **removed**.
- `src/server/find-agent/tools.ts:773` / `:819` — caps recall/safety rows returned (8 / 3) — proposed fate: **kept as guardrail** (tool payload size; not inventory choose).
- `src/server/find-agent/tools.ts:848-885` — market comps filters in-hand + fresh search; caps cards — proposed fate: **moved into SERV tool param** for query; card cap **kept as guardrail** (payload).
- `src/domain/find-agent.ts` — `FIND_AGENT_LOOP` off switch — **removed** (verified: env ignored; `findAgentLoopEnabled` is keyed-SERV only).
- `src/domain/find-agent.ts:296-326` — `applyFindAgentGuardrails` drops invented VINs; clamps offerUsd to budget — proposed fate: **kept as guardrail** (VIN ∈ results + budget math); prefer repair-to-SERV over silent clamp when possible (`issuesForSubmit` already repairs).
- `src/domain/find-agent.ts:336-387` — submit_picks validation issues returned to SERV — proposed fate: **kept as guardrail**.
- `src/server/find-agent/loop.ts:727+` / budget pause — pauses under request time budget — proposed fate: **kept as guardrail** (infra).
- `src/server/find-agent/map-to-decide.ts:64-68` — caps offerPool at 40 known listings — proposed fate: **kept as guardrail** (payload).
- `src/server/find-agent/map-to-decide.ts:71-72` — first pick order = SERV picks order — proposed fate: **kept as guardrail** (SERV-owned).

---

## 6. `/api/find/decide` + orchestrator + triage/decide SERV

- `src/app/api/find/decide/route.ts:62-95` — empty listings → settled nothing-fits, no charge — proposed fate: **kept as guardrail** (matches charge goal for empty).
- `src/app/api/find/decide/route.ts:14-17` / sync — no debit on decide — proposed fate: **kept as guardrail** today; goal still wants charge on choose/nothing-fits (may move debit here later).
- `src/server/find-decide-orchestrator.ts:131-180` — replay settle with `servKey: null` → code triage/decide — proposed fate: **kept as guardrail** (idempotent replay).
- `src/server/find-decide-orchestrator.ts` — agent loop only; on failure returns `agent_loop_failed` (no classic fallthrough) — verified: **removed** agent-fail fallback. Unkeyed / missing Auto.dev → `agent_loop_required` (503) — classic triage→decide product path **removed** (idempotent settled replay with `servKey: null` **kept**).
- `src/server/find-decide-orchestrator.ts:401-406` — triage `revisit.needed` marked used without rematch — proposed fate: **removed** (SERV revisit/re-search not executed).
- `src/server/find-decide-orchestrator.ts:413` — if shortlist empty, takes code `ranked.slice(0, 8)` — proposed fate: **removed**.
- `src/server/find-decide-orchestrator.ts:461-470` — code downgrades confidence when recall check failed — proposed fate: **kept as guardrail** (evidence math) or repair to SERV challenge.
- `src/server/find-triage-serv.ts:75-84` — `codeShortlist` top 3–8 by score — proposed fate: **removed**.
- `src/server/find-triage-serv.ts:135-141` — filters implausible/excluded before SERV triage — proposed fate: **kept as guardrail** for implausible odometer; excluded-from-pick must be evidence-tagged.
- `src/server/find-triage-serv.ts:316-331` — SERV fail → code shortlist published — proposed fate: **removed** (repair/fail, don’t code-choose).
- `src/server/find-decide-serv.ts:184-206` — codePick from ranking when shortlist empty — proposed fate: **removed**.
- `src/server/find-decide-serv.ts:496-516` — publishes code pick when SERV decide unavailable — proposed fate: **removed**.
- `src/server/find-decide-serv.ts` (challenge clamps / confidence min of C3/C4/guardrails) — proposed fate: **kept as guardrail** (confidence math / allowlist).
- `src/domain/find-best-deal.ts` (`selectBestDealOnEvidence` scoring) — code ranks cars for triage/display — proposed fate: **removed** as choose-owner; may remain as **non-authoritative** feature sheet inputs **moved into SERV tool param**.

---

## 7. Charge / delivery / agent-find API

- `src/domain/find-delivery.ts:18-23` — charge on any delivered cards — proposed fate: **removed** (goal: chosen car or explained nothing-fits only).
- `src/app/api/match/route.ts:329-381` — debit path on Show-cars success — proposed fate: **removed** / relocate per goal.
- `src/server/agent-find.ts:504+` — MCP/API v1 debit when cars delivered — proposed fate: **removed** same as match.
- `src/server/agent-find.ts:385` — flip path `topFlipCandidates(..., 8)` — proposed fate: out of personal-Find scope; note as flip code-rank (**removed** if Find-mode shared).

---

## 8. Eval / live Find

- `eval/live/run-one.ts:165-171` — passes `zip`/`distanceMiles` from generated templates into `understandNeed` — proposed fate: **kept as guardrail** for harness (simulates tagged user geo); ensure templates don’t imply product defaults.
- `eval/live/templates.ts:36-43` — city templates ship preset `radiusMi` (50–100) — proposed fate: **kept as guardrail** (eval fixtures = explicit); not product code path.
- `eval/live/run-one.ts:200-220` — still runs `runFindMatch` (code search) before decide/agent — proposed fate: **removed** from goal architecture (live eval should exercise SERV search tools, not code match invent).
- `eval/live/run-one.ts:267-295` — stepped decide orchestrator (includes agent loop) — proposed fate: **kept as guardrail** (harness).
- `eval/live/harness.ts` — spend caps maxQueries/maxUsd — proposed fate: **kept as guardrail** (eval budget infra).

---

## 9. Cross-cutting regex / note intake (feeds many paths)

- `src/domain/note-intake.ts` (`budgetFromText`, `yearsFromNote`, `miles`, body, AWD, fuel, history) — silent structured extract used as constraints — proposed fate: **moved into SERV tool param** as evidence; **removed** as hard filters without SERV/user tag.
- `src/domain/need.ts:496-505` — `useCaseFromText` regex — proposed fate: **removed** as search driver (`proposeDirections` use-case pools).
- `src/domain/city-to-zip` via `attachNoteGeo` — city→ZIP inference — proposed fate: **kept as guardrail** when labelled + user-confirmable; must not also invent radius.

---

## Counts

| Metric | Count |
|--------|------:|
| **found** (decision / default / filter / rank-to-drop / cap / early-exit / override points listed) | **120** |
| **suggested removed** | **62** |
| **suggested moved into SERV tool param** | **12** |
| **suggested kept as guardrail** | **46** |

*(Primary fate only — first bold fate tag on each bullet. `still present` primary → removed target. Compound bullets that also mention a secondary kept/moved still count under the primary. Enforced by `scripts/serv-boundary-audit-counts.test.ts`.)*

---

## Highest-leverage clusters (for structural follow-up)

1. **Code still searches:** `runFindMatch` + `proposeDirections` / open-starter widen + hard gate + diversify-8 — entire pre-SERV inventory brain.
2. **`search_listings` is not a thin proxy:** soft price×1.05, funnel **filters**, limit defaults/caps.
3. **Defaults as constraints:** 100 mi radius, budget year bands, `$40k` radar fallback, `budgetKnown=true` UI init, dirty-tagged null radius.
4. **Code choose fallbacks:** triage/decide code shortlist/pick when SERV fails; orchestrator `ranked.slice(0,8)`.
5. **Charge timing:** debit on Show-cars cards, not on SERV choose / nothing-fits.

---

## Out of scope (noted, not counted)

- Resale-only loops, Deal Radar cycle, next-check legacy path when `decidePath` off.
- Pure copy/UI formatting without affecting search constraints or pick.
- Auth session gates (`requireVerifiedAccountForFind`) — infra, not SERV boundary.
