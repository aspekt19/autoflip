# Resale + Deal Radar SERV capabilities

Code owns every dollar figure, VIN, URL, and listing. SERV only chooses among **allowlisted** options. TypeScript validates every SERV output against the input evidence bundle; unsupported references are rejected, logged as `rejected: unsupported reference`, and replaced by deterministic fallbacks — and that rejection appears in the decision journal.

**Addendum 2 (zero fabrication):** nothing the agent/LLM produces may invent listings, prices, VINs, mileage, or URLs. Structured fields are clamped to allowlists; free text is number/VIN/URL/evidence-checked; displayed dollars carry provenance.

## Capabilities

| Profile id | Decides | Inputs (code) | Outputs (schema) | Limits |
|---|---|---|---|---|
| `resale_plan_search` | Which search segments/models to run; whether to widen | `allowedDirections`, budget, ZIP/radius | `directionIds` (≤3), `widen`, `note` | 14s; ids must be allowlisted |
| `resale_triage` | Which shortlist VINs to deep-check; which checks to run; which to skip | `allowedVins`, `allowedCheckIds`, P&L facts | `deepCheckVins`, `skipVins`, `checkIds`, `note` | 16s; ≤3 deep VINs, ≤4 checks |
| `resale_pick` | Best flip VIN + shopper action | allowlisted VINs + computed profit/ROI/comps | `pickVin`, `action`, `note`, `evidenceIds` | 14s; pickVin allowlisted |
| `resale_challenge` | Agree or revise pick | primary pick + allowlists | `agrees`, `pickVin`, `action`, `objection`, `evidenceIds` | 14s; revise only to allowlisted VIN |
| `verdict_decide` / `verdict_challenge` | Shared shopper action path (also used when a ComputedReport is built for the pick) | report facts / gates | action + challenge | Existing Check/report limits |
| `radar_review` | Alert vs skip for **NEW** radar listings only | allowlisted VINs + P&L | `decisions[{vin,verdict,note}]` | 14s; bounded per cron run |

System instructions for each profile require: **only use provided evidence ids**; never invent or free-type prices / VINs / mileage / listings / URLs; every claim must cite an allowlisted id; any mentioned number must already appear in facts.

## Deep-checks (code executes what triage selected)

After `resale_triage`, TypeScript runs free public lookups for the allowlisted check ids:

| checkId | Source | Effect |
|---|---|---|
| `price_comps` | Already computed P&L | Journals basis; thin comps lower risk multiplier |
| `vin_decode` | NHTSA vPIC | Confirms or marks decode unavailable |
| `recalls` | NHTSA recallsByVehicle | **Rejects** on park-it; otherwise journals campaign count |
| `complaints` | NHTSA complaintsByVehicle | Journals make/model/year count (not VIN-specific) |
| `history` | Listing fields only | Unknown unless accidentCount present |

Then code **re-ranks by risk-adjusted mid profit**. Challenge may still revise the pick; revisions appear in the journal as `Changed pick from X to Y because…`.

## Call budget

- Resale search: hard cap **6** paid SERV calls per delivered search (`RESALE_SERV_CALL_CAP`).
- Deal Radar cron: bounded separately (≤3 review calls per watch run unless documented otherwise). Same journal schema (`lemonless.resale_journal.v1`) for every Radar run.

## Evidence validation (code)

Module: `src/domain/resale-serv-validate.ts`

1. Every VIN / URL / evidence id in SERV output must appear in the input bundle.
2. Free-text numbers must pass `quotedNumbersStayIn` against computed facts.
3. Failures → journal step with `rejected: "rejected: unsupported reference"` + deterministic fallback.
4. `stripUnsupportedNumbers` can scrub free-text digits when a note is retained only for diagnostics.
5. Adversarial unit + settle tests mock SERV inventing VINs/prices/URLs — must reject.

## Data provenance (displayed numbers)

Module: `src/domain/resale-provenance.ts` + `ResaleCandidatePnl.provenance`.

| Kind | Meaning |
|---|---|
| `autodev_listing` | Copied from Auto.dev listing (keyed by VIN) |
| `nhtsa` | Public NHTSA endpoint |
| `computed` | Formula from code (e.g. profit = resale × (1 − friction) − all-in) |
| `assumption` | Labeled estimate with basis (fees, recon, negotiate haircut) |
| `unknown` | Explicit unknown — never a silent default as fact |

UI: Resale candidate cards show a **Number sources** list. Estimates (fees, recon, negotiate) always include basis text.

## Decision journal

Schema: `lemonless.resale_journal.v1` (`src/domain/resale-decision-journal.ts`).

Each step: actor (SERV|code), decided, why, inputsUsed, changed (pick revisions highlighted), model, responseId, timestamp, rejected (if any).

Shown on Resale results and every Deal Radar activity entry.

## Enforcement report (Addendum 2)

| Rule | How enforced |
|---|---|
| Dedicated capabilities + strict JSON schemas | `PROFILES` in `src/server/serv/profiles.ts`: `resale_plan_search`, `resale_triage`, `resale_pick`, `resale_challenge`, `radar_review` — `additionalProperties: false`, enum/allowlist fields |
| System: evidence ids only; no invented prices/VINs/listings/URLs | Profile `system` + `shadowHint` strings; documented above |
| Validate SERV output vs input bundle | `validateResaleServOutput` on plan/triage/pick/challenge; Radar notes via `quotedNumbersStayIn` / journal mapping |
| Unsupported ref → reject + journal + code fallback | Settle writes `rejected: "rejected: unsupported reference"` and keeps code rank/pick |
| Strip / verify free-text numbers | `quotedNumbersStayIn` reject path; `stripUnsupportedNumbers` helper |
| Displayed numbers carry source | `ResaleCandidatePnl.provenance` + Resale UI “Number sources” |
| Unknown ≠ guessed fact | `unknownProvenance` / null tax / null days-to-sell; basis strings say “unknown” |
| Estimates labeled with basis | negotiate / tax / title fee / recon / days / channel fields |
| Adversarial mocked SERV invents data | `resale-serv-validate.test.ts`, `resale-settle-serv.test.ts` inventing VIN/price/URL |
| Mocks test-only | No production seed listings/alerts; mock `fetch` only in Vitest |

## Honesty

- No seeded fake listings or alerts.
- Unknowns stay explicit (`unknown`, never a silent default as fact).
- Fee/recon estimates labeled with basis.
- Mocks test-only.
