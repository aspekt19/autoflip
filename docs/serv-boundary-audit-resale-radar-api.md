# SERV boundary audit — Resale / Radar / API v1 / MCP

**Branch:** `cursor/serv-boundary-structural-3e9b`  
**Scope:** Resale agent loop/tools, resale-job, resale-search, settle, Radar criteria/normalize/cycle, `/api/v1/*` find/resale/radar, MCP tools, shared `search_listings` / Autodev proxy (as used by these), eval/live Resale.

**Related:** Find-focused structural notes also live in `docs/serv-boundary-audit.md`. This file is the exhaustive Resale/Radar/v1/MCP decision inventory.

**Goal architecture (reminder):**
- SERV gets raw user words + **only** user-explicitly-set fields (tagged). No defaults as constraints.
- SERV owns search / re-search / relax / choose / nothing-fits.
- `search_listings` = thin proxy: unfiltered results + funnel; no code filters/caps/early exits.
- Code after SERV: validate listing in results, VIN/price/mileage, budget, math only; else repair to SERV.
- Charge only on chosen flip/car or explained nothing-fits.

**Format:** `path:line` — what it does — proposed fate: `removed` | `moved into SERV tool param` | `kept as guardrail` (justification)

Line numbers from this branch at audit time; prefer symbols if they drift.

---

## 1. Shared `search_listings` + Autodev proxy

### Caps / defaults on args

- `src/server/find-agent/tools.ts:126-127` — `LISTING_CAP = 12`, `LIMIT_MAX = 20` hard page caps — **removed** (or raised to provider max and returned fully; SERV chooses how many to read).
- `src/server/find-agent/tools.ts:166-175` — `parseLimitArg` defaults omitted `limit` to **12**; rejects `>20` — **removed** default; **moved into SERV tool param** for requested limit (validate positive int only as guardrail).
- `src/server/find-agent/tools.ts:23` / `485-486` / `555-557` / `736-737` — `SEARCH_LISTINGS_PRICE_SOFT_FACTOR = 1.05` widens provider + post-filter price ceiling beyond SERV’s `priceMaxUsd` — **removed** (do not silently widen SERV’s price); soft admit belongs in SERV re-search if wanted.
- `src/server/find-agent/tools.ts:475-502` (`toListingQuery`) — invents year ranges `1980-…` / `…-2100`, `priceRange` `1-…`, `milesRange` `0-…`, forces `used: true`, clamps `limit` via `Math.min(..., LIMIT_MAX)` — year/price/miles padding **moved into SERV tool param** (SERV must send exact provider bounds); `used:true` **kept as guardrail** (product: used-car inventory only); limit clamp **removed** with LISTING_CAP.
- `src/server/find-agent/tools.ts:451-458` / `717-718` — `capListingCards` truncates returned cars to page limit — **removed** (return all funnel survivors; SERV ranks).
- `src/io/autodev.ts:56` — provider URL defaults `limit` to **20** when omitted — **moved into SERV tool param** (always pass explicit limit from tool args).
- `src/io/autodev.ts:84` — VDP lookup hard `limit: 10` — **kept as guardrail** (single-VIN path, not agent search).
- `src/io/autodev.ts:133` — YMM fallback search `limit: 50` — **kept as guardrail** (VDP exact-match helper).
- `src/io/autodev.ts:25-26` / `170` — Autodev ownership timeout default **12_000** ms — **kept as guardrail** (infra timeout, not inventory constraint).

### Code filters inside `applySearchListingsFunnel` (violates thin-proxy goal)

- `src/server/find-agent/tools.ts:538-539` — drops rows missing VIN/year/make/model — **kept as guardrail** (malformed provider rows; not a shopper preference).
- `src/server/find-agent/tools.ts:541-542` — `isPassengerOrLightTruck` passenger gate — **moved into SERV tool param** (or return raw + funnel annotation without deleting rows from the payload SERV sees).
- `src/server/find-agent/tools.ts:544-547` — transmission post-filter — **moved into SERV tool param** (funnel-only; do not delete).
- `src/server/find-agent/tools.ts:549-553` — body family/style post-filter — **moved into SERV tool param** / funnel-only.
- `src/server/find-agent/tools.ts:555-558` — price post-filter (with 1.05 soft ceiling) — **removed** soft factor; price filter **moved into SERV** (funnel annotation OK; do not drop from returned set if goal is unfiltered).
- `src/server/find-agent/tools.ts:561-563` — miles post-filter (unknown miles kept) — **moved into SERV** / funnel-only.
- `src/server/find-agent/tools.ts:566-570` — radius post-filter (unknown distance kept) — **moved into SERV** / funnel-only.
- `src/server/find-agent/tools.ts:573-581` — fuel/drivetrain soft post-filters (not even named funnel steps) — **removed** as silent deletes; **moved into SERV tool param**.
- `src/server/find-agent/tools.ts:505-515` — transmission match treats unknown transmission as pass — **kept as guardrail** once filter is SERV-owned (honesty).
- `src/server/find-agent/tools.ts:517-526` — unknown observed body passes body intent — same as above.

### Funnel / relax hints (advisory to SERV — OK if not auto-applied)

- `src/server/find-agent/tools.ts:586-628` (`relaxHintsFromFunnel`) — suggests omit_body / widen_radius / raise_price / etc. — **kept as guardrail** (hints only; SERV must decide). Ensure no code auto-applies these.
- `src/server/find-agent/tools.ts:370-371` / `751-752` — tool description + honesty string steer SERV toward `bodyFamily=car`, omit_body before raise_price — **moved into SERV tool param** / prompt policy (product guidance OK in system prompt; not a code filter).

### Comps / other tools reused by Resale

- `src/server/find-agent/tools.ts:773` — recalls capped to **8** rows — **kept as guardrail** (payload size; not pick ranking).
- `src/server/find-agent/tools.ts:819` — safety variants capped to **3** — **kept as guardrail**.
- `src/server/find-agent/tools.ts:859` — `get_market_comps` auto-fetches when `<3` in-hand — **moved into SERV tool param** (SERV should request search; code should not auto-search).
- `src/server/find-agent/tools.ts:848-854` — comps in-hand filtered by make/model/year/price — **kept as guardrail** (tool-arg application of SERV-requested filters).
- `src/server/find-agent/tools.ts:885` — comps cards capped via LISTING_CAP — **removed** with listing cap.

### Provider body-style rewrite

- `src/server/find-agent/tools.ts:492-493` / `704` + `providerBodyStyleParam` — omits Sedan/car-family from provider query — **kept as guardrail** (provider quirk; must stay visible in `providerBodyStyle` result field — already returned).

---

## 2. Resale agent tools / PnL injection / ranking

- `src/server/resale-agent/tools.ts:125-131` — `rankFlipCandidates(..., enforceSanity: false)` then skips `estimate.excluded` — still **rank-to-drop** / order by code score before SERV sees cards — **moved into SERV tool param** (return unordered PnL facts; SERV chooses). Ranking for display only is OK if not used to drop.
- `src/server/resale-agent/tools.ts:136-144` — drops excluded estimates; only emits PnL for requested batch — excluded drop **removed** for agent path (emit honesty + nulls); batch scoping **kept as guardrail**.
- `src/server/resale-agent/tools.ts:215` — `get_flip_pnl` caps VINs to **20** — **kept as guardrail** (tool abuse / payload).
- `src/server/resale-agent/tools.ts:274-293` — after `search_listings`, auto-computes `flipPnl` for returned cars — **kept as guardrail** (math facts for SERV; not a pick).
- `src/server/resale-agent/tools.ts:122` — comps pool needs `>=3` known listings else uses batch alone — **kept as guardrail** (math sample; document thin comps).

---

## 3. Resale agent domain guardrails / mode defaults

- `src/domain/resale-agent.ts:53` — `RESALE_AGENT_LOOP` default **`auto`** (on when SERV key present) — **kept as guardrail** (feature flag, not shopper constraint).
- `src/domain/resale-agent.ts:58-60` — e2e stub forces classic path unless explicitly on — **kept as guardrail** (test harness).
- `src/domain/resale-agent.ts:74` — `RESALE_AGENT_MODE` default **`auto`** — **kept as guardrail**.
- `src/domain/resale-agent.ts:257` — default pick `why` invents copy when missing — **kept as guardrail** (presentation fill).
- `src/domain/resale-agent.ts:301-347` (`applyResaleAgentGuardrails`) — **drops** invented VINs; **clamps** offer to budget; **clamps** buy/negotiate/needs_inspection → pass on negative mid-profit — VIN allowlist + budget/math clamps **kept as guardrail**; silent drop/clamp path is superseded by `validateResaleSubmitPicks` on tools mode — prefer repair-only (**kept as guardrail** with repair loop; do not silent-drop in tools mode).
- `src/domain/resale-agent.ts:359-418` (`validateResaleSubmitPicks`) — rejects invented VIN, offer > budget, offer > asking, buy/negotiate on negative mid — **kept as guardrail** (validate + repair to SERV).
- `src/domain/resale-agent.ts:192` / string slices — max string lengths — **kept as guardrail**.

---

## 4. Resale agent loop (prompts, caps, early exits)

- `src/server/resale-agent/loop.ts:321-325` — system prompt: prefer tight filters; hard budget; prefer `bodyFamily=car`; profit/sell-window not inventory filters — prompt bias **moved into SERV tool param** / policy (OK as SERV instructions, not code filters).
- `src/server/resale-agent/loop.ts:514` — finish repair context caps known VINs to **40** — **kept as guardrail** (context size); ensure full allowlist still validated separately.
- `src/server/resale-agent/loop.ts:755-772` / `1070-1087` — early-exit round when request deadline low (`AGENT_LOOP_BUDGET_CONTINUE`) — **kept as guardrail** (Hobby wall-clock; continue next step).
- `src/server/resale-agent/loop.ts:1423` — default `maxRounds = 40` runaway guard — **kept as guardrail**.
- `src/domain/agent-loop-deadline.ts:17-23` — request budget 270s; min remaining 90s to start round — **kept as guardrail**.
- `src/server/resale-agent/loop.ts:849` / submit nudge — forces `submit_picks` after empty tool round — **kept as guardrail** (protocol); must not invent picks.
- Tools vs next_action fallback on unsupported tools — **kept as guardrail** (transport).

---

## 5. Resale search input — defaults tagged as constraints

- `src/domain/resale-search-input.ts:64-66` — budget required — **kept as guardrail** (product entry requirement).
- `src/domain/resale-search-input.ts:173` — `repairAbility` defaults to **`unknown`** when omitted — **kept as guardrail** if tagged non-constraint; today it flows into PnL/recon as if set — **moved into SERV tool param** / tag as unset (do not treat as user preference).
- `src/domain/resale-search-input.ts:193-195` — `asIs` inferred from freeText regex when field omitted — **removed** as silent constraint (or tag as extracted-from-words for SERV, not a form default).
- `src/domain/resale-search-input.ts:205-210` — `sellWithinDays` inferred from freeText when field omitted — same: **moved into SERV** / tagged extract, not silent form default.
- `src/domain/resale-search-input.ts:229` — `timeToSell` defaults to **`any`** — **removed** as constraint (omit / null when unset).
- `src/domain/resale-search-input.ts:239` — `resaleChannel` defaults to **`private_party`** — **removed** as constraint unless user-set (affects PnL).
- `src/domain/resale-search-input.ts:149-151` — freeText truncated to 500 — **kept as guardrail**.
- `src/domain/resale-search-input.ts:278-320` (`needFromResaleSearchInput`) — synthesizes note; sets `budgetKnown: true`, `yearBandResolved: true` even when years null, `openToOtherMakes` from empty prefs, injects preferredMakes from models — `yearBandResolved: true` with null years **removed** (lets budget year band apply as if resolved — see directions); other mapping **moved into SERV** tagged fields.
- `src/domain/resale-search-input.ts:293` — injects “Prefer faster-turning inventory when ranking” when `timeToSell === "faster"` — **moved into SERV** (ranking signal only if user-set).

---

## 6. Classic Resale search (`runResaleSearch`) + directions / find-match

### Editorial directions as inventory constraints

- `src/domain/directions.ts:57` — `MAX_DIRECTIONS = 3` — **moved into SERV tool param** (SERV chooses how many / which models).
- `src/domain/directions.ts:77-88` — `proposeDirections` fills yearMin/yearMax from `yearBandForBudget` when user did not set years — **removed** as search constraint (do not send budget-band years to provider as if user-set).
- `src/domain/need.ts:1145-1190` (`yearBandForBudget`) — invents year bands by budget tier — **removed** from inventory constraints; OK as SERV-visible suggestion only.
- `src/domain/directions.ts:136` / `156` / `195` / `220` — models sliced to **6** per direction — **moved into SERV**.
- `src/domain/directions.ts:164` / `176` / `187` — caps editorial extras to MAX_DIRECTIONS — **moved into SERV**.
- `src/domain/directions.ts:199+` — body-filter fallback invents directions when body wipes list — **moved into SERV** (SERV re-searches).
- `src/domain/directions.ts:334+` — hardcoded COMPACTS/CROSSOVERS/TRUCKS editorial tables — **moved into SERV** (guidance, not code-forced queries).
- `src/domain/directions.ts:400` — budget `<12_000` forces older compact editorial path — **removed** as constraint.

### `runResaleSearch` plan / inventory / rank

- `src/server/resale-search.ts:35-36` — `RESALE_ALTERNATIVE_LIMIT = 4`, `RESALE_SHORTLIST_LIMIT = 8` — **moved into SERV** (shortlist size); alternatives cap for UI **kept as guardrail** only if post-SERV presentation.
- `src/server/resale-search.ts:171` / `RESALE_INTERNAL_BUDGET_MS` — ~270s step budget — **kept as guardrail**.
- `src/server/resale-search.ts:192-201` / `232-238` — filters SERV plan direction ids to editorial allowlist; falls back to **all** directions if empty — allowlist clamp **kept as guardrail**; fallback-to-all when SERV returns empty **moved into SERV** (SERV should say nothing-fits / re-plan, not silent expand).
- `src/server/resale-search.ts:273-283` — early exit 504 on time budget before inventory — **kept as guardrail** (no charge).
- `src/server/resale-search.ts:287` — inventory stage cap `min(60s, remaining-8s)` — **kept as guardrail**.
- `src/server/resale-search.ts:292-303` — `runFindMatch` with parallel queries + stage cap — provider pacing **kept as guardrail**.
- `src/server/resale-search.ts:329-350` — `enforceSanity: true`, `topFlipCandidates(..., 8)`, sell-window blocked filtered out of top, then relax path if empty — **rank-to-drop / early empty** — **removed** from pre-SERV path (SERV owns choose/nothing-fits); sanity as **facts** OK.
- `src/server/resale-search.ts:473` — full-path body sets `chargedCredit: true` before job debit layer — charge semantics owned by job; classic one-shot path charges on delivery even when `best` null (empty pool) — **removed** / align with “charge only on chosen flip or explained nothing-fits”.

### `runFindMatch` (shared inventory used by classic Resale)

- `src/server/find-match.ts:50` — `FIND_MAX_PROVIDER_QUERIES = 6` — **moved into SERV** (query budget); infra safety cap **kept as guardrail** if tagged.
- `src/server/find-match.ts:218-223` — invents `budget-only` direction when none — **moved into SERV**.
- `src/server/find-match.ts:261` — passenger filter on non-flip collected rows — N/A for flip; personal **moved into SERV**.
- `src/server/find-match.ts:284-288` — flip keeps over-budget asks in comps pool but blocks other hard drops — price-as-comp **kept as guardrail** (math); other hard drops **moved into SERV** visibility.
- `src/server/find-match.ts:495` / `546` / `578` / `587` / `625` — provider `priceMax` + client filters `priceUsd > budget` — soft admit via `admitFindListingForBudget` / `budgetFit` 1.05 — **removed** silent 5% over-budget admit as constraint; **kept as guardrail** only if labeled over-budget for SERV.
- `src/domain/budget.ts:22-26` — `budgetFit` allows 5% over as `slight` — **removed** as silent inventory admit; **moved into SERV**.
- `src/domain/find-listing-price.ts:101-119` — budget admission gate — validate-only after SERV pick **kept as guardrail**; pre-filter of pool **removed**.
- `src/server/find-match.ts:507-515` — inventory stage AbortController early stop — **kept as guardrail**.
- `src/server/find-match.ts:649+` / `filterInventoryWithWiden` — soft-filter then radius widen (never nationwide) — **removed** auto-widen from code; **moved into SERV** re-search.
- `src/domain/inventory-widen.ts:144-247` — ordered drop_soft + distance steps — **moved into SERV**.
- `src/server/find-match.ts:894-895` — hides implausible odometer from rankedReady — **rank-to-drop** — **removed** / surface as fact to SERV.
- Empty-inventory messaging that invents next steps (raise budget / clear filters) — presentation **kept as guardrail**; must not charge as success without SERV nothing-fits.

---

## 7. Flip rank / sanity / PnL math (shared Resale + Radar flip)

- `src/domain/flip-rank.ts:92-107` — sorts by excluded, mileage bias, score — **moved into SERV** for pick order; OK as optional tool “code_rank_hint”.
- `src/domain/flip-rank.ts:110-113` (`topFlipCandidates`) — filters `excluded` + `sellWindowBlocked`, slices limit — **removed** as pre-SERV drop.
- `src/domain/flip-rank.ts:151-152` — sell window blocks pick when days unknown or over window — **moved into SERV** (signal, not hard drop).
- `src/domain/flip-rank.ts:180-190` — `enforceSanity` excludes via `resaleSanityReason` — **removed** as silent exclude for agent/SERV path; **kept as guardrail** fact fields.
- `src/domain/flip-rank.ts:192-204` — `< minComps` → excluded (`NOT_ENOUGH_SIMILAR_CARS`) — **kept as guardrail** for math honesty; do not drop from SERV-visible inventory.
- `src/domain/flip-rank.ts:209-216` — suspicious price floor/ratio exclude — **kept as guardrail** (fraud/anomaly math) with SERV-visible reason.
- `src/domain/flip-rank.ts:222-227` — score factors: confidence 0.75, asIs 0.85, sellWindowExceeded 0.5, clearsTarget false 0.5 — **moved into SERV** (ranking policy).
- `src/domain/flip-rank.ts:254-280` — age-based speed factors (0.75 / 1.1) — **moved into SERV**.
- `src/domain/resale-sanity.ts:8-11` — hard miles cap **180k**, span slack, min near comps **5** — **removed** as inventory delete; **kept as guardrail** labeled facts / repair.
- `src/domain/resale-sanity.ts:40-42` (`resaleMilesCap`) — clamps user milesMax to 180k — **removed** silent clamp of user field; **kept as guardrail** warning only.
- `src/domain/resale-sanity.ts:117-141` (`postFilterFlipInventory`) — drops over budget×1.05, over miles, salvage, outside radius — **removed** from pre-SERV inventory; validate on chosen VIN **kept as guardrail**.
- `src/domain/resale-sanity.ts:27-37` — mileage rank bias 20k gap — **moved into SERV**.
- `src/domain/assumptions.ts:35-48` — title fee 350, recon bases, negotiate haircut 5%, sell friction 3%, desired profit **1500**, thin margin 500, suspicious ratio/floor — math assumptions **kept as guardrail** (printed); `flipDesiredProfitUsd` must not act as user target when unset (**removed** as constraint — see settle/verdict).
- `src/domain/resale-pnl.ts:87-90` / ranking tax haircut when tax unknown — **kept as guardrail** (math; labeled).
- `src/domain/verdict.ts` `flipVerdict` + `ASSUMPTIONS.flipDesiredProfitUsd` when target null — **removed** as implicit user target; use null-target policy only.

---

## 8. Resale settle SERV (`runResaleSettleServ`)

- `src/server/resale-settle-serv.ts:113` — `RESALE_SERV_JUDGE_MAX = 3` shortlist for SERV judge — **moved into SERV** (SERV sees full candidate set or asks for pages).
- `src/server/resale-settle-serv.ts:788-797` — code `sortByProfit` then keeps only non-negative mid, slice to 3 — **rank-to-drop** — **removed**.
- `src/server/resale-settle-serv.ts:799-824` — early empty shortlist → pass / “no candidates” without SERV choose — **removed** (SERV nothing-fits).
- `src/server/resale-settle-serv.ts:459-485` (`pickAlternatives`) — drops alts where ask and offer both over budget; limit 4 — budget validate **kept as guardrail**; pre-drop before SERV **removed**.
- `src/server/resale-settle-serv.ts:187-265` — confidence caps (stop flags, margin miss, honesty) — **kept as guardrail**.
- `src/server/resale-settle-serv.ts:551-596` (`clampFlipPublishedAction`) — caps SERV buy/negotiate to pass on park-it / park-outside / negative margin / walk_away — **kept as guardrail** (documented hard facts); soft `flipDesiredProfitUsd` explicitly does not override — good.
- `src/server/resale-settle-serv.ts:508-538` (`flipMarginPublishedAction`) — code-owned action from margin when SERV skipped — **removed** as substitute for SERV decide; honest skip only.
- `src/server/resale-settle-serv.ts:931+` — code rank journal “Top: … (code P&L only)” before triage — **moved into SERV**.
- Triage allowlist clamp of deep/skip VINs + checks — **kept as guardrail**.
- Time-budget skips of SERV stages — **kept as guardrail**.
- `src/server/resale-settle-serv.ts:341` / `379` / `416` — slice peers/questions/risks for prompts — **kept as guardrail** (prompt size).

---

## 9. Resale job + credit + agent map

- `src/server/resale-job.ts:51` / deadline per step — **kept as guardrail**.
- `src/server/resale-job.ts:812-918` — agent loop preferred on step 2; on success jumps to final step + `chargeAndStoreDelivery` — charges even when `publishedBest` null / emptyReason set — **removed** unless SERV produced explained nothing-fits (map currently sets emptyReason without requiring relaxedConditions) — align charge gate.
- `src/server/resale-job.ts:919` — fallback to classic inventory on agent failure — **moved into SERV** retry; classic path reintroduces code rank (**removed** long-term).
- `src/server/resale-job.ts:395-428` — debit on delivery; unpaid still shows result — **kept as guardrail** (billing honesty).
- `src/server/resale-agent/map-to-settle.ts:41` — pads candidates from pnl map up to **12** — **moved into SERV**.
- `src/server/resale-agent/map-to-settle.ts:62-70` — picks first non-pass as best; alts slice 4 — presentation after SERV **kept as guardrail**.
- `src/server/resale-agent/map-to-settle.ts:128-131` — skipReason invents sell-window / below-similar copy when no best — **removed** if not from SERV summary/relaxedConditions.
- `src/server/resale-agent/map-to-settle.ts:184` — shortlist slice 8 — **moved into SERV**.
- `src/server/resale-agent/map-to-settle.ts:204` — `chargedCredit: false` in map (job charges) — OK.
- `src/server/resale-search-credit.ts:50` — short default timeout for credit lock — **kept as guardrail**.

---

## 10. Radar criteria / normalize / provenance

- `src/server/radar-normalize-criteria.ts:14-21` — freeText/notes truncated 500 — **kept as guardrail**.
- `src/server/radar-normalize-criteria.ts:22-29` — `criteriaParseSource` defaults to **`form`** even without freeText — **removed** false provenance; use unset/null when unknown.
- `src/server/radar-normalize-criteria.ts:32-41` — invents `criteriaOrigin` find/resale from mode when freeText present — **moved into SERV** / require explicit origin.
- `src/server/radar-normalize-criteria.ts:50-59` — radius default: flip → **0** (nationwide), personal → criteria or **50** for legacy — legacy **50** **removed** as active constraint for new watches; nationwide 0 for flip when explicit **kept as guardrail** if user-tagged nationwide.
- `src/server/radar-normalize-criteria.ts:78` — flip `repairAbility` defaults **`unknown`** — tag unset (**moved into SERV**).
- `src/domain/radar-watch.ts:192-197` (`toListingsQuery`) — `limit: ASSUMPTIONS.radarPageSize` (**20**), priceRange exact max (no 1.05 here) — page size **moved into SERV**/config; price max **kept** as user field.
- `src/domain/watch-queries.ts:5-18` — `MAX_PERSONAL_MODELS = 6`; broad flip invents Toyota Corolla/RAV4/Camry × `FLIP_SCAN_PAGES=3` — **removed** invented models as constraints; **moved into SERV**.
- `src/domain/watch-queries.ts:72-75` — price-drop threshold $300 and 3% — **kept as guardrail** (seen-book refresh policy) or **moved into SERV** if alert policy should be model-owned.
- `src/domain/radar-watch.ts:220-249` (`hardReject`) — make/model/price/year/miles/body/radius/new-car/current-year rejects — user-set fields **kept as guardrail** validate; **new-car / current-year** product rules **kept as guardrail**; do not apply unset optional fields.
- `src/domain/radar-watch.ts:276-323` (`prefilterListing`) — flip sanity + margin≥0 + minProfit; personal only good/fair tone — **rank/filter-to-drop before SERV** — **removed**; pass candidates + facts to SERV review.
- `src/domain/radar-watch.ts:256-260` — roughMargin uses assumption recon/title/friction — **kept as guardrail** (labeled math).
- `src/domain/radar-watch.ts:363-366` — `intervalHours` clamps 3–24h from monthly budget — **kept as guardrail** (ops quota).
- `src/domain/radar-watch.ts:381+` (`rankPasses`) — ranks personal passes — **moved into SERV** for alert choice.
- `src/domain/assumptions.ts:52-61` — radar monthly budget 650, max alerts/search **5**, max SERV/search **3**, check-now window 30m — **kept as guardrail** (plan/ops caps).

---

## 11. Radar cycle / radar SERV

- `src/server/radar-cycle.ts:47` — `CYCLE_BUDGET_MS = 270_000` — **kept as guardrail**.
- `src/server/radar-cycle.ts:204-228` — skip watches without paid plan / due interval — **kept as guardrail**.
- `src/server/radar-cycle.ts:244-253` — early budget exit on listings — **kept as guardrail**.
- `src/server/radar-cycle.ts:302-307` — flip: `topFlipCandidates(..., radarMaxAlertsPerSearch=5, enforceSanity:true)` before SERV — **removed** pre-SERV rank-to-drop.
- `src/server/radar-cycle.ts:318-325` — already-seen filter unless price drop — **kept as guardrail** (dedupe) with SERV re-review for not_reviewed.
- `src/server/radar-cycle.ts:536-537` — personal winners `slice(0, radarMaxServPerSearch=3)` — **kept as guardrail** (plan SERV cap) — document as quota not quality filter.
- `src/server/radar-cycle.ts:506-519` — model match + seen filter; comps pool not miles-capped for badge — good; keep.
- `src/server/radar-serv.ts:238-254` — no SERV key / timeout → `alertWorthy: false` (no code-only alert) — **kept as guardrail**.
- `src/server/radar-serv.ts:285` — maps buy/negotiate → alert — **kept as guardrail** (schema mapping).
- `src/server/radar-serv.ts:318+` / challenge veto — challenge can only veto alert — **kept as guardrail**.
- Comment at `radar-serv.ts:183` (stale: “returns alertWorthy=true with code-only”) vs implementation false — docs drift; implementation **kept**.

---

## 12. API v1 — Find / Resale / Radar

### Resale

- `src/app/api/v1/resale/route.ts` — thin POST → `createAgentResaleRun` — no extra filters.
- `src/server/agent-resale.ts:37-57` — requires budgetUsd — **kept as guardrail**.
- `src/server/agent-resale.ts:59-70` — passes only provided optional fields (zip/distance/body/makes/maxMiles/…) — good; unset stays null — **kept**.
- `src/server/agent-resale.ts:107` — `maxSteps` default 1 or 6 if untilDone — **kept as guardrail**.
- Status/result payloads expose journal/proof — **kept**.

### Find

- `src/app/api/v1/find/route.ts:52` — `budgetUsd` only if number else null — **kept**.
- `src/server/agent-find.ts:260` — mode defaults to **personal** when not flip — **kept as guardrail** if tagged; ensure not inventing flip constraints.
- `src/server/agent-find.ts:504` — debit only when cars delivered; empty inventory no charge — **kept as guardrail** (matches goal better than classic resale one-shot).
- `src/server/agent-find.ts:519` — top listings slice **8** for response — **kept as guardrail** (response shape) if full set available to SERV earlier.
- Find decide orchestrator / agent loop (out of deep Find audit but shared): same `search_listings` issues as §1; Find settle does not replace ranked car — note as open boundary (out of Resale scope detail).

### Radar v1

- `src/server/agent-radar.ts:80` — mode defaults **personal** — **kept as guardrail**.
- `src/server/agent-radar.ts:81` — requires priceMax — **kept as guardrail**.
- `src/server/agent-radar.ts:106-110` — flip treats null/invalid radius as **nationwide** — **kept as guardrail** if explicit product rule; tag as user-omitted → nationwide.
- `src/server/agent-radar.ts:125` / example bodies use radius **50** / **100** — docs examples only.
- `src/server/agent-radar.ts:200-213` — plan watchLimit cap — **kept as guardrail**.
- `src/server/agent-radar.ts:219` — default watch name from mode — **kept as guardrail** (label).
- `src/server/agent-radar.ts:222` — `normalizeCriteria` (see §10).
- `src/server/agent-radar.ts:300` — feed alerts `slice(0, 40)` — **kept as guardrail** (pagination).

---

## 13. MCP tools

- `src/server/mcp.ts:208-210` (`parseMode`) — non-flip → **personal** — **kept as guardrail**.
- `src/server/mcp.ts:65-79` (`deal_radar`) — make/model required; distanceMiles optional — **kept**.
- `src/app/api/mcp/route.ts:325-354` — `assembleRadar` then `scoreRadar` (code scores entire set, no SERV pick) — code rank/score for MCP scan **moved into SERV** if MCP should match site SERV path; or document as **non-decision** scoreboard (**kept as guardrail** if explicitly non-alerting).
- `src/server/assemble.ts:977-985` — distance default **50** (with zip) or **100** when distanceMiles omitted — **removed** as constraint; omit → nationwide/unspecified.
- `src/server/assemble.ts:987` — provider priceMax × **1.05** — **removed**.
- `src/server/assemble.ts:995` — limit **20** — **moved into SERV**/explicit.
- `src/server/mcp.ts:81-97` (`resale_search`) — budget required; optional zip/distance/body/targetProfit — good; wires same job path (§9).
- `src/server/mcp.ts:122-158` — radar_watches / save / check_now / feed → agent-radar (§12) — same normalize/defaults.
- MCP `find_cars` → agent-find charge-on-delivery — **kept**.
- Credit: deal_radar / radar_* free; resale charges on final verdict — align with nothing-fits rule (§9).

---

## 14. Eval / live Resale

- `eval/live/run-one-resale.ts:2-3` — never charges report credits — **kept as guardrail**.
- `eval/live/run-one-resale.ts:74-88` — `parseBudgetUsd` from note; `pnlOptions.repairAbility: "unknown"` always — repair default **moved into SERV** / omit; budget parse from words OK as eval harness.
- `eval/live/run-one-resale.ts:100` — continue hops cap **40** — **kept as guardrail**.
- `eval/live/run-one-resale.ts:169-175` — scoring OK if chosen VIN **or** nothing-fits (toolRounds>0 + relaxedConditions + summary) — **kept as guardrail** (eval contract matching goal).
- `eval/live/harness.ts:37-39` / `215-216` — max queries default **8**, max USD **3** — **kept as guardrail** (eval spend cap).

---

## 15. Cross-cutting Autodev / quota

- `src/domain/assumptions.ts:50` — `autodevMonthlyStop: 900` — **kept as guardrail**.
- `src/io/autodev.ts` monthly reserve / demo_limit early exit — **kept as guardrail**.
- Cache TTL/entries (`assumptions.cacheTtlMs` / `cacheMaxEntries`) — **kept as guardrail**.

---

## Counts

| Fate | Count |
|------|------:|
| **removed** | 52 |
| **moved into SERV tool param** | 61 |
| **kept as guardrail** | 78 |
| **Total decision points listed** | **191** |

### Hotspots (highest concentration of `removed` / `moved`)

1. `search_listings` funnel filters + caps + 1.05 soft price (`find-agent/tools.ts`)
2. Classic Resale: `proposeDirections` / `yearBandForBudget` / `topFlipCandidates` / `enforceSanity` (`directions`, `need`, `resale-search`, `flip-rank`)
3. Settle shortlist `RESALE_SERV_JUDGE_MAX` + profitable-only pre-filter (`resale-settle-serv.ts`)
4. Radar `prefilterListing` + broad-flip invented models + topFlip before SERV (`radar-watch`, `watch-queries`, `radar-cycle`)
5. Input defaults: `timeToSell=any`, `resaleChannel=private_party`, `repairAbility=unknown`, radius **50**, parseSource **form** (`resale-search-input`, `radar-normalize-criteria`, `assemble`)

### Already aligned (call out)

- Tools-mode `validateResaleSubmitPicks` repairs to SERV instead of silent clamp.
- Radar no-key path does not alert on code price alone.
- Agent Resale system prompt already forbids inventing dollars; PnL from code tools.
- Find API empty inventory does not charge; live-eval Resale scores nothing-fits.
- `clampFlipPublishedAction` does not let soft desired-profit override SERV.

---

*Audit only — no product fixes in this commit.*
