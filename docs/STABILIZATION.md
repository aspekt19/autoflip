# Lemonless: fresh-eyes root-cause review

Reviewed: `main` @ 140b70a (2026-11-12, ~02:30 UTC+3). Evidence: code (file:line at 140b70a) and the live prod runs in
`/workspace/serv-compare-e2e-nov12/raw/armA/*/meta.json` and `e-radar/run2.json`. No SERV, Auto.dev or other paid calls were made for this review.

## TL;DR (the blunt version)

The product does not break because of 40 separate bugs. It breaks because of **five structural decisions**, and each patch so far has fixed a symptom of one of them:

1. **No single search spec.** User intent lives in five overlapping copies (client strings, `StructuredNeed`, `FindPlan`, `SearchDirection[]`, `refine`), and **nothing enforces hard limits on the listings that come back**. Budget, year, radius and stale state "leak" because there is no source of truth to leak *from*.
2. **"SERV fails → code fallback" is designed in.** Every one of the 29 SERV profiles has a `fallback`. A refusal or a timeout is not retried. It quietly turns into a weaker code path. The worst case: a zero-query search shown with "Verdict: Pass".
3. **Time budgets are built for a 60 s platform limit that no longer exists.** Vercel Hobby is now 300 s, but the code still uses 15–38 s per-call timeouts, a 50 s resale handler and a 52 s radar cycle for all users. That is why we see 15 s and 22 s timeouts despite the "90 s policy".
4. **The resale profit model is structurally biased toward bad cars.** It buys at dealer retail, "sells" at the median of other dealers' asking prices minus 3 %, and adjusts mileage linearly. The biggest "profit" is therefore the biggest anomaly, such as a 303,830-mile Civic.
5. **The tests exercise the mocks.** Stub upstreams ignore every query parameter, Playwright replaces `/api/need` with its own regex, and the HTTP e2e runs exactly one happy-path note. None of the tests asserts an invariant on the output.

On top of that, the codebase is about 99k lines of non-test TypeScript (plus 52k lines of tests) for a hackathon product. It ships two Find decision pipelines, a 15k-line hidden "Scout" subsystem, and a 3,342-line `AssistantFlow.tsx` with 66 `useState` calls. Every new patch lands in this sprawl, and every patch can break something nobody tests.

**Recommendation:** stop patching symptoms. Spend about 2 days on 6 PR-sized units: canonical spec, hard-limit gate, SERV failure policy, time budgets, a server-side Run with a permalink, and a golden suite. Freeze everything except **Find, Resale and Check-by-VIN**, plus the minimal honest Radar and /proof.

---

## 1. Ranked root causes

### RC1. No canonical search spec, and no hard-limit gate (causes: wrong budget, stale state, year ignored, radius doubts, 2012 trucks in a 2018+ search)

**Where intent gets merged today (five places, each with different precedence):**

| Layer | File:line | What it does |
|---|---|---|
| Client wizard strings | `src/components/AssistantFlow.tsx:248,302-303,284-286` | `budget`, `yearMin`, `zipDraft` and `distanceDraft` are free strings in React state |
| Client → `/api/need` | `AssistantFlow.tsx:431,439` | Sends `budgetUsd` from the **closure** value of `budget` |
| Server form-vs-note merge | `src/domain/need.ts:992-1000` (`overlayExplicit`) | **Any numeric form budget beats the note** |
| SERV plan payload | `src/server/understand-need.ts:87-93,149-154` | Sends the (possibly stale) form budget to SERV as `formOverrides`; the prompt tells SERV that form numbers are allowed (`profiles.ts` find_plan system) |
| Code fallback plan | `src/domain/find-plan.ts:657-660` | The form budget again beats the note |
| Directions snapshot | `src/domain/find-plan.ts:602-614` | Copies `yearMin`/`yearMax` into each direction **at plan time** (1990–2027 when the note had none) |
| Client → `/api/match` | `AssistantFlow.tsx:1478-1487` | Sends `need` (with the Confirm edits), `directions` (the stale snapshot) **and** `refine` |
| Matcher | `src/server/find-match.ts:244-247` | If `directions` is present, `refine` is ignored |
| Matcher dispatch | `find-match.ts:359-375` (`dispatchOne`, and the parallel copy ~410-425) | Uses `direction.yearMin/yearMax`; **`need.yearMin` is never read** |
| Match route | `src/app/api/match/route.ts:60-66,150` | Passes the raw client body, including client-supplied `directions`, straight to `runFindMatch` (the client can steer the paid search) |

**Concrete mechanisms behind tonight's bugs:**

- **Stale budget (the "$8,000 read as $20k, $20k as $30k, $30k as $8k" pattern).** `AssistantFlow.tsx:2047-2051` calls `setBudget(parsed)` and then `void understand(...)` **in the same tick**. `understand()` reads the old `budget` from its closure (`:431`), so the *previous search's* budget is sent as a form override. The server then treats it as authoritative (`need.ts:992-1000`). The off-by-one-search pattern in the runs is exactly this bug. The `freshNote` flag clears ZIP and radius (`:419-420`) but not the budget.
- **"Oldest year 2018" ignored.** The year was set on Confirm after the plan, so it updated `need.yearMin` (`AssistantFlow.tsx:2376-2381`). The directions still carried 1990 from `planToDirections`, and `find-match.ts` dispatches with `direction.yearMin`. Nothing re-filters the returned listings.
- **There is no post-filter anywhere.** `io/autodev.ts` returns whatever the provider sends. `find-match.ts` filters on budget only (`withinBudget`, `:186-195`). Year, miles, radius, drivetrain and body are never checked on the way out. Any provider quirk, cache hit (the TTL cache is keyed by URL) or wrong direction leaks straight to the UI and to SERV.
- **Latent bug:** `src/server/assemble.ts:1066-1075` (`yearQuery`). With `yearMin` only, it returns `{ year: min }`, an **exact year** rather than "≥ min". It is masked today only because `planToDirections` always fills both ends.
- **Idempotency key leak:** `AssistantFlow.tsx:1455-1470,1548` stores `af-find-idem` in sessionStorage and clears it **only on success**. After any failed search, the next search reuses the key, and `/api/match` can replay the *old* delivery (`match/route.ts:85-90`). This is another source of "previous search bleeds into this one".

**Answer to Q1:** no, there is no canonical spec object. `StructuredNeed` comes closest, but the matcher does not read it for years, and directions are a stale denormalised copy.

**Proposal: `SearchSpec` v1, owned by the server and immutable per run**

```ts
type Prov = "note" | "form" | "serv" | "default";
type Hard<T> = { value: T; source: Prov; quote?: string };   // must hold for every result
type Soft<T> = { value: T; source: Prov; weight: "prefer" };  // ranking only
type SearchSpec = {
  v: 1; id: string; hash: string;            // hash of the canonical JSON = cache key + audit id
  mode: "personal" | "flip";
  note: string;
  hard: { priceMaxUsd?: Hard<number>; yearMin?: Hard<number>; yearMax?: Hard<number>;
          milesMax?: Hard<number>; zip?: Hard<string>; radiusMi?: Hard<number|null>;
          drivetrain?: Hard<"awd_4wd">; bodyStyles?: Hard<string[]>; excludeMakes?: Hard<string[]>;
          titleClean?: Hard<true> };
  soft: { models: Soft<{make:string;model:string}[]>; fuel?: Soft<string>; seatsMin?: Soft<number>;
          priorities: Soft<string[]>; targetProfitUsd?: Soft<number>; sellWithinDays?: Soft<number>; asIs?: Soft<boolean> };
  queries: { make?: string; model?: string; bodyStyle?: string }[];   // derived, never empty (see RC2)
};
```

Rules:

1. **One builder** `buildSearchSpec({ note, formEdits, servPlan })` on the server. Precedence: a form field the user *touched in this session* (the client sends `dirty: true`) beats a note literal, which beats SERV, which beats the default. A number that is in neither the note nor a dirty form field is rejected. SERV may add soft preferences and models; it may only *propose* hard limits, which need a verbatim quote.
2. **The client sends only `{ note, formEdits: { field: { value, dirty } } }`.** It never sends `directions`, `need` or `refine`. `/api/match` takes `specId`.
3. **One gate:** `enforceHard(spec, listings)` runs at the single inventory boundary, before comps, before SERV, before the UI. It returns `{ kept, dropped: [{ vin, rule }] }`. Dropped counts are shown in plain words ("12 listings outside your 2018+ limit were hidden").
4. **Every step** (triage, decide, challenge, resale P&L, radar) receives `spec` plus `spec.hash`, and its proof record carries `spec.hash`. Confirm edits create a **new** spec (new hash), never a mutation.

### RC2. SERV failure policy: silent degradation instead of an honest retry or a clear stop

**How calls are made:** `runServ` (`src/server/serv/run.ts:505-957`) uses chat/completions with `response_format: { type: "json_schema", strict: true }` (`run.ts:767-777`) for all `find_*`, `resale_*` and `verdict_*` profiles (`profiles.ts:1738-1767` forces `chat`). `find_plan` additionally uses `kronos-multipath`, the `prompt_guard` tool and `contentFilter: default_on` (`profiles.ts:234-257`). No `temperature` or `seed` is set anywhere (grep: zero hits), so verdicts are non-deterministic by construction. That explains the different verdict on the identical second resale run.

**Why "first car" died.** The chain, step by step:

1. SERV returned HTTP 200 with `content: null` and a `refusal` field. In structured mode, `fromMessage` returns the refusal string as text (`run.ts:334-336`), so the "empty text → re-POST" (`run.ts:732-739`) never fires. `structuredRefusalOnly` (`run.ts:840-845`) then fails the call.
2. `isServRetryableFailure` (`src/server/serv/transport-error.ts:48-62`) only retries 5xx, network, unparseable or invalid output. A **refusal (HTTP 200, no error class) is not retryable**, and a **timeout is explicitly not retryable** (`:58`). So no retry happened (`understand-need.ts:178-201`).
3. The fallback `fallbackFindPlan` (`find-plan.ts:650-787`) found no named model or make, so it built `bodyStyleOnlyDirection(["any"])` with `models: []` (`find-plan.ts:293-311,732-744`).
4. `planToDirections` maps body `"any"` to `bodyStyle: undefined` (`find-plan.ts:619-630`). `queriesForDirection` then has no model, no make and no body, and returns `[]` (`find-match.ts:164-182`). The result: **zero provider queries**, an empty pool, "Pool empty — code shortlist only" (`find-triage-serv.ts:295`), and a code "Pass".

So the fallback for the *most common real query* (a budget plus "reliable", no model) is structurally a no-op. **This happens even without a refusal:** any plan whose directions all lose their models in `validateFindPlan` and whose body is `any` produces zero queries.

*Why did plan refuse?* The raw refusal text was deliberately not persisted, so this is unknown. The plausible triggers are the `prompt_guard`/`content_filter` layer reacting to "new driver" (possible-minor heuristics) or kronos-multipath on this schema. **Do not guess. Log the refusal category** (the code already computes `failureDiag.reasonCode`) **and handle it.**

**Every timeout and retry in the codebase** (at 140b70a):

| Where | Value | Notes |
|---|---|---|
| `need_guard`, `need_extract`, `check_guard` | 8 s | `need_*` are dead (no callers outside journal copy and eval) |
| `listing_extract`, `report_guard`, `agent_guard`, `flip_feasibility` | 12 s | |
| `check_rules`, `flip_judge`, `telegram_reply` | 15 s | **15 s = the Radar "manual check" timeout seen live** (flip_judge in the radar path) |
| `personal_alert_review` | 16 s | **The only profile with a timeout retry** (8 s first try, then the rest; `run.ts:718-726`) |
| `find_close_call_multipath` | 16 s | |
| `verdict_decide` | 18 s | |
| `verdict_challenge`, `find_pick` | 22 s | **22 s = the resale verdict_challenge timeout seen live** |
| `report_explain`, `agent_explain`, `find_next_check` | 25 s | |
| `radar_guard` | 35 s | |
| `resale_plan_search/triage/pick/challenge`, `radar_review` | 38 s | |
| `scout_plan` | 45 s | `scout/planner.ts:88` |
| `find_plan`, `find_triage`, `find_decide`, `find_challenge` | 90 s | the only profiles that honour the "90 s policy" |
| `servBudget()` | min(profile, remaining, ceiling) | `profiles.ts:1705-1708`; every caller clamps further |
| Resale deadline | 50 s internal, 52 s hard cap; stages plan 35 / inventory 22 / triage 35 / deep 8 / pick 35 / challenge 35 / shopper 35 s | `src/domain/resale-deadline.ts:23-53` |
| Radar cycle | 52 s total for **all users' watches**; autodev 8, serv 40, telegram 5, kite 8 s | `src/server/radar-cycle.ts:50-57` |
| Find inventory stage | 60 s cap; Auto.dev 12 s per call | `find-match.ts:392-405`, `io/autodev.ts:168` |
| Gov / NHTSA / vPIC / KV | 12 / 12 / 12 / 8 s | `io/gov.ts:14`, `io/nhtsa-safety.ts:41`, `io/vpic-catalog.ts:29`, `io/kv.ts:226` |
| Route `maxDuration` | 300 s: need, match, find/decide. **60 s: everything else** (resale ×3, report, check, radar ×2, cron, mcp, v1/*) | `src/app/api/**/route.ts` |
| Client aborts | 290 s (need, match) | `AssistantFlow.tsx:429,450` |
| Silent re-POSTs | empty text: 1× (`run.ts:732-739`); find_plan: 1× on 5xx/network/unparseable/invalid, without the kronos suffix (`understand-need.ts:185-202`) | **refusals and timeouts are never retried** |

**Is the fallback design sound?** No.

- Each of the 29 profiles has a `fallback` (`"deterministic_fallback"`, `"code_pick"`, `"ignored_malformed"`, `"publish_c3_capped"`, …). The architecture's default answer to "SERV failed" is "publish something anyway". This collides with the core claim ("SERV decides") and with the honesty rule.
- Confidence is not reduced when a step failed. Live resale showed "Medium" with a failed challenge.
- Specific garbage paths observed: the zero-query search turned into "Pass"; a challenge timeout turned into a verdict without a challenge, still at Medium.

**Proposed policy (one function, all steps):**

| Failure class | Action |
|---|---|
| Transport timeout or 5xx/network | Retry once with the same profile, provided the remaining budget is ≥ the profile timeout |
| Refusal or validation fail | Retry once on bare `gpt-6.1-sol` without kronos/multipath/prompt_guard; log `reasonCode` |
| Still failing on a **critical** step (plan, decide) | **Stop the run with a clear message and no charge** ("Our AI couldn't plan this search; no credit used. Try rephrasing…"). Never publish a code verdict labelled as a decision |
| Still failing on a **non-critical** step (challenge, explain) | Publish the result, label it "Second check did not finish", and cap confidence at Low |

And a hard invariant: **`queries.length > 0` before any charge or verdict.** If the plan yields no model or body, run one budget-only inventory query (price, miles, year, zip/radius with no make). That is real data, not invented.

### RC3. Time budgets for a platform limit that no longer exists

- Vercel Hobby with Fluid compute now has a **300 s default and maximum** (Vercel docs, *Functions limits* and the *higher defaults* changelog: "Hobby 300s (previously 60s)"). The repo still believes 60 s: `api/radar/cron/route.ts:6` says "Hobby allows 60 seconds", and `api/resale/search/route.ts:18-20` says "Keep maxDuration at 60".
- The consequences are the whole stepped resale job machinery (`resale-job.ts`, 1,062 lines), the 22 s challenge timeout and the 52 s radar cycle. Each one is an artificial cap of the kind the owner banned ("no hidden budget ceilings; timeouts only").
- **Radar scheduling is broken at the infrastructure level.**
  - `vercel.json` has one cron, `0 14 * * *` (**daily**).
  - The "hourly" scheduler is `.github/workflows/radar-cron.yml:9` (`0 * * * *`), and GitHub Actions is dead on billing.
  - Meanwhile `src/app/pricing/page.tsx:118` tells paying users: "**The scheduler ticks hourly**…", and the plans promise 6 h / 3 h cadence. That is a false product claim. "Last run 11/10" is consistent with it. Check the Vercel cron logs for whether even the daily job runs; that needs `CRON_SECRET` set, and I checked names only.
- **Side note:** Vercel Hobby is "non-commercial, personal use only" (the Hobby plan page). Selling $100/$250 subscriptions on it is fine for a Stripe-TEST demo, but say "test mode" everywhere and do not claim live revenue.

### RC4. The resale model selects for anomalies

- `src/domain/flip-rank.ts:61-63,155-157` computes `profit = fairMid × (1 − 3 %) − ask − exampleCost`, and the score is `profitMid × confidence × speed`. Fair value is the median of *other dealers' asking prices in the same 20-row scan*, with **linear** adjustments of 0.5 % per 1k miles and 5 % per year (`adjusted-comparables.ts:9,320-330`).
  - Buying at retail and selling at retail-minus-3 % is not a flip. The only "profit" left is where a listing is priced below its peers, which is usually because the market knows something: 300k miles, title, damage. Ranking by that gap is **adverse selection**.
  - The 303,830-mile Civic is not a bug in the ranking. It is the ranking working as designed.
- Linear mileage extrapolation far outside the comp range is unbounded. A 303k car against ~100k comps is a 200k extrapolation. The only guard is `suspiciousPriceRatio` (`flip-rank.ts:141`).
- `recon.ts` always adds at least $600 × skill. There is **no "as-is" path** even when the user says "as-is".
- The `flipDesiredProfitUsd: 1_500` default (`assumptions.ts:40`) is applied as a target the user never set.
- Days to sell is a proxy from **the seller's own listing age** (`resale-pnl.ts:162-190`): a car stuck 61 days on a lot gets "61 days to sell", which conflates the seller's failure with your future sale. It does not compare against the user's 30-day goal.
- `limit: 20` per query with no sort (`assemble.ts:980-982`, `io/autodev.ts:54`) gives the **20 most recently updated** listings per model (the Auto.dev default sort is `updatedAt.desc`). That is not the cheapest or the nearest, which is why "budget barely used".

**What it should be** (honest, achievable in 1 day):

1. Hard sanity gates before ranking:
   - miles ≤ min(user cap, 180k) and within the comp mileage span ± 30 %;
   - year within the comp span;
   - ≥ 5 comps within ± 25 % miles;
   - no salvage or flood when known.
2. Value the subject only **inside the comp range** (an interpolation window). Never extrapolate.
3. Rename the output from "profit" to **"priced below similar listings by $X (after costs)"**. Make it explicit that the sale price is an asking-price proxy. Show "why is it cheap?" checks as the SERV job: mileage, title, accidents, listing age.
4. Respect `asIs` (recon 0, risk up), `sellWithinDays` (penalise when the proxy is greater) and a user-set target (no default target).
5. Pass `sort=price.asc` plus the price range so the 20-row budget goes to cars the user can afford.

### RC5. The test pyramid tests the mocks

- **HTTP e2e:** `scripts/e2e-find-radar-stub-upstreams.mjs:310-313` returns the **same 4 RAV4s for any `/listings` URL**, already within every filter. A filter that is never applied cannot fail. The note is a single happy path (`scripts/e2e-find-radar.ts:20-22`, "Toyota RAV4 near Miami under $18,000…"), the budget is hard-set in the request (`:118`), and the stub SERV returns a perfect plan (`stub-upstreams.mjs:121-135`). No refusal, timeout or empty plan is ever exercised.
- **Playwright** `e2e/find-intake.spec.ts:24-58,40-58` replaces `/api/need` **with its own regex budget parser**. That is exactly the code that broke.
- **pages-smoke** checks HTTP 200 and layout, not behaviour.
- **vitest**: 281 test files and 52k lines, overwhelmingly unit tests of copy, lineage and labels. 528 inline fetch mocks. `fixtures/serv/recordings/` is **empty**. The honesty rule ("never invent SERV responses") was over-applied to tests too, so nothing replays a real SERV or Auto.dev response through the real pipeline.
- **Zero invariant checks on outputs:** no assertion anywhere that "every shown listing satisfies the spec".

### RC6. Surface and code sprawl

- ~99k lines of non-test code: Scout ~15k (hidden behind a flag), Find ~19k, Resale ~8k, Check ~8k, Radar ~5k, Agent/MCP ~5.5k, `serv/` ~5k.
- **Two Find decision pipelines ship.** `FIND_DECIDE_PATH` defaults ON (`src/domain/find-decide-path.ts:7`), but `find-next-check-orchestrator/live/claim` (~2.5k lines) plus `find_next_check` and `find_pick` remain wired.
- 29 SERV profiles. At least 4 are dead or eval-only (`need_guard`, `need_extract`, `telegram_reply`, and `personal_alert_review`, which still has special-case code in `run.ts:718-726`).
- `AssistantFlow.tsx` is 3,342 lines with 66 `useState`. The UI is a state machine that nobody wrote down. In-progress versus final contradictions are its symptom.
- **Copy is generated in domain code and then regex-scrubbed for jargon.** `src/domain/serv-decision-step.ts:165` writes `inputs digest …`, and `src/domain/serv-decision-journal-copy.ts:42,69` strips it again. Every new internal string leaks until someone adds a regex. That is why jargon keeps coming back.

### RC7. No server-side Run, so no permalink, no consistent final state and weak auditability

The Find result exists only in browser state assembled from 3–4 separate responses (`/api/need`, `/api/match`, `/api/find/decide`, optionally next-check). Proof records are scattered. "Auditable steps" is a **judging criterion**, yet the judge cannot open a URL that shows one run end to end. Resale has a job object (`resale-job.ts:281`); Find does not.

**Fix:** a `Run { id, spec, steps[] (each with SERV response id, model, latency, status, retryOf), inventory snapshot (VINs + kept/dropped), final decision }` persisted in KV, with `/run/[id]` as the permalink. The UI renders `Run` only, so progress and final come from the same object and cannot contradict each other. The same object goes to /proof and the API.

### RC8. Honesty and copy gaps (each small, together damaging)

- "Scheduler ticks hourly" (false, RC3).
- "Verdict: Pass" when no search ran (RC2).
- Medium confidence with a failed challenge.
- "We checked crash-test ratings" when all 5 lookups came back empty (pickup run).
- A $1,500 target the user never set.
- "Decided planned" wording.
- A Carfax or Autolist link shown as "the listing".
- Rule conflict: never-forget #25/#26 says "No x402", yet `src/server/agent-x402.ts` and `io/x402.ts` are wired into `/api/v1/*` and `/api/mcp` (gated by `agentPaymentsEnabled`). Make sure that flag is off in prod (check the env NAME only), or delete the code.

---

## 2. Data source limits (Q5)

- **Auto.dev is adequate for the demo if used correctly.** Per the docs (docs.auto.dev, *Vehicle Listings*):
  - `zip` + `distance` filtering exists, with **distance defaulting to 50** when only a ZIP is given;
  - year, price and miles ranges are supported;
  - `/listings` by default **returns only rows that have a price, a VDP link and photos**;
  - `sort=price|miles|year|createdAt|updatedAt` works, but not by distance;
  - the per-plan `limit` caps at 20 on Free (the code uses 20).
- Mileage is present (`retailListing.miles`), and so is `distance` per row (`parsers.ts:85`). **The code never checks `distanceMiles` against the radius.** The resale "radius not applied" observation is unproven: Easton PA (~70 mi) and Berlin CT (~100 mi) are both within 100 mi of 10001. Add the post-filter and show distance on cards; the doubt goes away.
- **Wrong dealer links have two probable causes:**
  1. **Feed data.** `retailListing.vdp` is often a dealer-group or syndication site, for example a group domain such as `koch33…` serving several franchises, or Carfax/Autolist. That is real data, but a buyer reads it as "wrong dealer". Show the link host ("listing on carfax.com") and treat aggregator hosts as "find it via" (`listing-vdp-verifiability.ts:119-129` already has the list).
  2. **A code mix-up.** `AssistantFlow.tsx:2693-2697` takes `vdp: row.vdp ?? card?.vdp` but `dealer: card?.dealer || row.dealer`, which is **opposite precedence**. If `cardForRow(row)` resolves to a different car, the link and the dealer name come from two different listings.

  Fix: one listing object keyed by VIN; no field-level merging between row and card.
- **Hard limits of the data:** asking prices only (no sold prices, no wholesale), so true flip profit cannot be computed (RC4). There is no reliable towing capacity, which should stay an "unknown" plus an advice line. Drivetrain is available as `vehicle.drivetrain` and should become a hard filter when the user says "need 4x4".

---

## 3. Cut / hide / freeze list (4 days left)

**Must be rock-solid for the demo (the only things judges should touch):**

1. **Find** (personal). Free-text note → spec → inventory → SERV plan/triage/decide/challenge → verdict, with a permalink.
2. **Resale.** Budget → spec → inventory → sanity-gated "priced below similar" → SERV pick/challenge → verdict, with a permalink.
3. **Check by VIN.** Reportedly the path where SERV already truly decides (Nov 10 live e2e). Regression-test it; do not touch it otherwise.
4. **Deal Radar, minimal and honest.** Saved watches plus a **"Run now"** button that reuses the Find/Resale Run, plus a daily Vercel cron. Change the copy to "checks daily" and drop the 6 h / 3 h claims until a real scheduler exists. This is the revenue story, so keep it, but shrink it.
5. **/proof + "How it decides"**, rendered from real `Run` records (permalinks), with no hand-written content.

**Freeze (no new work; keep it if it works, hide it if it breaks):**
- Check by **link** (403s from Vercel on the major sites).
- `/api/v1/*` + MCP + `/developers`: keep the docs, no new endpoints.
- Compare cars, Favorites, Reports list (Reports only as the permalink index).
- `/verify`.
- PR #159 (capability matrix "coordinated defaults"): do **not** merge before the demo. It changes model behaviour across all steps. Close #137.

**Hide or delete:**
- **Scout** (15k LOC, already flagged): remove it from nav permanently and exclude it from the judge write-up.
- **Next-check loop pipeline** (`find-next-check-*`, `find_next_check`, `find_pick`): the decide path is the default. Delete or hard-disable it.
- **Telegram** (already hidden), **x402** (contradicts the rules), **kite-pay**.
- Dead profiles: `need_guard`, `need_extract`, `telegram_reply`, `personal_alert_review`.

---

## 4. Stabilization plan: next 2 days, ordered PR-sized units

> **Coordination:** cloud agent bc-2dba6ec6 is patching the symptom list in one PR. Do not duplicate it. Let it land only if it passes U0's golden suite; otherwise park it and fold its useful copy fixes into U1–U6. The units below change the *structure*, so many of its patches become unnecessary.

**U0. Golden suite skeleton plus a record/replay transport (½ day, comes FIRST)**
- Add `test/golden/` (spec in §5). Build the replay transport on top of the existing injectable `deps.fetch` (`runServ` `ServDeps.fetch`; `AutodevDeps.fetch`). Recordings are real responses keyed by a request hash, with provenance (time, model, response id).
- Recording needs a live SERV + Auto.dev run: about 10 queries × ~5 SERV calls. **This is spend, so it needs Yura's OK** (within the existing $10 ceiling).
- Acceptance:
  - `npm run golden` replays all 10 cases offline in < 60 s;
  - it **fails on main today** for G1 (zero queries), G2 (year), G4 (303k Civic) and G9 (stale budget);
  - it runs in the local CI gate.

**U1. `SearchSpec` + `buildSearchSpec` + `enforceHard` (1 day)**
- Server builds the spec. The client sends `{ note, formEdits{value, dirty} }` only; the `directions`/`refine`/`need` bodies are removed from `/api/match` and the resale routes.
- `enforceHard` runs at the single inventory boundary. Drop counts are shown in plain words.
- Fix the `yearQuery` min-only bug (`assemble.ts:1066-1075`). Clear the idempotency key on *every* new spec, not only on success.
- Acceptance:
  - golden invariants I1–I4 hold on all 10 cases;
  - G9 sequence (SUV $20k, then "first car ~$8,000") gives a spec budget of 8000;
  - unit test: a dirty form field beats the note, a non-dirty field does not.

**U2. SERV failure policy + non-empty inventory guarantee (½ day)**
- One `callStep()` wrapper implements the retry table in RC2: retry a refusal once on bare `gpt-6.1-sol`, retry a timeout once; on a critical step, stop with "no charge", never a code verdict; on a non-critical step, label it and cap confidence at Low.
- `queries.length === 0` turns into a budget-only inventory query. Persist the refusal `reasonCode`.
- Acceptance:
  - replay of a recorded refusal (G1 raw) leads to a retry and then a result **or** an honest "couldn't plan, no credit used";
  - never "Pass" with `providerQueriesUsed = 0` (I5);
  - a challenge timeout leads to confidence ≤ Low plus visible copy.

**U3. Time budgets and scheduler truth (¼ day)**
- Set `maxDuration = 300` on resale, report, check, radar, cron and v1.
- Collapse the resale stepping to at most 2 requests, or keep it with stage caps raised to the profile timeouts. One policy: every SERV step gets ≥ 90 s or the run is honestly stopped.
- Radar: the daily Vercel cron plus "Run now"; the copy says "daily"; delete the hourly claim and the GitHub Actions dependency.
- Acceptance:
  - grep shows no profile timeout under 60 s on find/resale/verdict/radar decision steps;
  - a cron dry run against a preview logs a run;
  - /pricing copy matches `vercel.json`.

**U4. Resale model honesty (½ day)**
- Add the sanity gates, interpolation-only valuation and `sort=price.asc` from RC4. Implement `asIs`, `sellWithinDays` and a user-only target. Rename the copy to "priced below similar listings (after costs)".
- Acceptance:
  - G4 (resale $15k, as-is, 30 days) never returns miles > 180k or outside the comp span;
  - recon = 0 when as-is;
  - a days-to-sell value > 30 is flagged in the verdict;
  - the same inputs replayed twice give the same pick. Decision determinism comes from the recorded responses plus a stable code ranking. For live runs, cache by `spec.hash` for 24 h.

**U5. Server-side `Run` + permalink + single render path (¾ day)**
- Persist `Run` (RC7). Add `/run/[id]`. Find and Resale render only from `Run` (polling `GET /api/run/[id]`). The journal reads `Run.steps`.
- Buyer copy comes from a **typed enum → copy table**, not from audit strings plus regex scrubbing.
- Acceptance:
  - each golden case produces a `Run` whose final state equals the last in-progress state plus the decision;
  - invariant I6 (no internal identifiers in rendered HTML) passes;
  - the permalink opens signed-out in read-only mode, or for the owner only (Yura's call).

**U6. Cut list execution + prod verification (¼ day)**
- Remove the next-check pipeline, the dead profiles, Scout from nav and the x402 wiring (or confirm it is disabled).
- Deploy pinned SHA. Run the golden suite **live** on prod for 4 cases (SUV, first car, pickup, resale) with Yura's OK for spend.
- Then, and only then, rerun the LLM comparison for /proof.
- Acceptance: live runs satisfy I1–I8. /proof shows the `Run` permalinks.

Total: about 3.75 dev-days of agent work. It fits in 2 calendar days with 2 parallel agents: U1 ∥ U3 + U4, then U2, then U5 ∥ U6. Recording (U0) is a blocker and needs the spend OK first.

---

## 5. Golden-query regression suite: spec

**Modes:**
- `replay`: default, CI, offline, deterministic.
- `record`: live SERV + Auto.dev; writes `test/golden/recordings/<case>/<reqhash>.json` with `{ request (no auth header), response, model, responseId, at }`. Needs a spend OK.
- `live`: hits prod or a preview over HTTP as a signed-in test user; no recording.

**Harness:** drives the **real** server functions (`buildSearchSpec` → inventory → steps → `Run`) with injected `fetch`. There is no mock of `/api/need` and no stub that ignores query params. In replay mode, an unseen request hash **fails the test**, so code changes that alter what we ask for are visible.

**Cases** (ZIP 10001, radius 100 mi unless stated; "+" marks a clarification turn):

| # | Mode | Note (+ form) | Key expectations |
|---|---|---|---|
| G1 | personal | "I need a reliable first car, budget about $8,000" + "it's for a new driver" | budget 8000; queries > 0; ≥ 1 result or an honest no-inventory message; never "Pass" with 0 queries |
| G2 | personal | "Looking for a pickup truck that can tow a camper, budget around $30k" + form oldest year 2018 + "prefer 4x4" | every result year ≥ 2018 and price ≤ 30k(+5 % rule); towing stays "unknown" |
| G3 | personal | "Family SUV under $20k, AWD, no accidents" | AWD required → every result's drivetrain is AWD/4WD or explicitly unknown-and-flagged; accidents 0 or unknown-flagged |
| G4 | flip | budget $15,000 + "buy as-is, sell within 30 days" | miles ≤ 180k and within the comp span; recon 0; days > 30 flagged; no default target |
| G5 | personal | "Honda Civic or Toyota Corolla under 15 grand, less than 60k miles" | models ⊆ {Civic, Corolla} first; miles ≤ 60k |
| G6 | personal | "cheap commuter with great gas mileage, max 12k, near Chicago" | ZIP resolved from the city (provenance "note"); price ≤ 12k |
| G7 | personal | "7 seats, minivan or 3-row SUV, $25,000 tops, not a Kia" | no Kia; seats ≥ 7 or flagged |
| G8 | personal | "I want a hybrid, budget 18-22k, newer than 2019" | price ≤ 22k; year ≥ 2020 ("newer than 2019"); fuel hybrid preferred |
| G9 | sequence | run "SUV under $20,000", then a fresh note "reliable first car about $8,000" in the same session | second spec budget = 8000; no replayed delivery; new idempotency key |
| G10 | flip | budget $5,000, Nationwide | radius null; queries > 0; no car > $5,250; honest low-confidence copy |

**Hard invariants (asserted on every case, in all modes):**
- **I1 Limits.** Every shown listing satisfies every `spec.hard` constraint: price ≤ max × 1.05 (if that is the documented rule, otherwise ≤ max), year in range, miles ≤ max, distance ≤ radius when the row has distance, excluded makes absent, required drivetrain matched or explicitly flagged "unknown".
- **I2 Budget parse.** `spec.hard.priceMaxUsd.value` equals the number stated in the note, or the dirty form value, exactly. The source is recorded.
- **I3 No stale state.** For sequence cases, spec N shares no field with spec N−1 unless it is present in note N or dirty in form N.
- **I4 Spec lineage.** Every step's proof record has `specHash === run.spec.hash`.
- **I5 No zero-query verdict.** `providerQueriesUsed > 0`, or the run status is `stopped` with no charge. A verdict (Buy/Negotiate/Pass/Skip) never appears with 0 queries.
- **I6 No internal names in the UI.** Rendered HTML matches none of: `/chatcmpl-|inputs digest|providerQueriesUsed|FIND_[A-Z_]+|serv_[a-z_]+|needs_inspection|evaluateListingPrice|sellFriction|idempotency|pnl:|\{\"|checkId|Pool empty/`. Response ids live only behind "Technical details", and in their own element.
- **I7 Failure honesty.** If any SERV step's status ≠ ok, confidence ≤ Low and buyer copy names the missing step. A critical step failing means no charge.
- **I8 Links.** Every "Dealer listing" href host is not in AGGREGATOR_HOSTS, *or* it is labelled with its host. The dealer name and the href come from the same listing object (same VIN).
- **I9 Determinism (replay).** The same case replayed twice gives an identical `Run.final` (pick VIN, verdict, confidence).
- **I10 Time.** Replay finishes < 5 s per case. In live mode, record wall time per step, and no step may time out below its profile timeout.

**Gate:** golden replay plus typecheck plus existing unit tests is the merge gate in local CI. The e2e stub server is upgraded to **honour** `vehicle.year`, `retailListing.price`, `retailListing.miles`, `zip`/`distance` and `vehicle.make/model`, so it can catch the class of bug it currently hides.

---

## 6. Other things that are fundamentally off

- **The verdict for an empty or failed run is a product decision, not a fallback.** "Find always gives a verdict" (never-forget #7) has been implemented as "always print a verdict word", which is how "Pass" appeared on a search that never ran. The rule should read: *always give a verdict when there is inventory; otherwise give an honest reason and charge nothing.* **Raise this with Yura**; it is his rule.
- **"SERV decides" versus code fallbacks.** Every profile can be replaced by code, and the UI does not consistently say so. Judges will check this. With RC2's policy, the claim becomes true: SERV either decided or the run says it could not.
- **Pickup case:** all three code close-call paths chose the 2012 F-150, and SERV chose 2018 "with no explanation to user". With `enforceHard`, the 2012 truck never reaches SERV, so this argument disappears.
- **Process.** Over 1.5 weeks there were ~500 commits, ~165 PRs and many agents. Each live run produced a bug list, and each list produced a PR fixing the list. Nothing ever added a test that reproduces the *live* failure from recorded data, so regressions came back. The golden suite (U0) is the single most important change, because it turns every future live failure into a permanent test.
- **Comparison and proof.** Agree with Yura: do not publish comparisons until G1–G10 pass live. The comparison should then run *from* `Run` permalinks so every Lemonless number is clickable to raw SERV and Auto.dev provenance.
