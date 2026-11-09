# Resale + Deal Radar SERV capabilities

Code owns every dollar figure, VIN, URL, and listing. SERV only chooses among **allowlisted** options. TypeScript validates every SERV output against the input evidence bundle; unsupported references are rejected, logged as `rejected: unsupported reference`, and replaced by deterministic fallbacks — and that rejection appears in the decision journal.

## Capabilities

| Profile id | Decides | Inputs (code) | Outputs (schema) | Limits |
|---|---|---|---|---|
| `resale_plan_search` | Which search segments/models to run; whether to widen | `allowedDirections`, budget, ZIP/radius | `directionIds` (≤3), `widen`, `note` | 14s; ids must be allowlisted |
| `resale_triage` | Which shortlist VINs to deep-check; which checks to run; which to skip | `allowedVins`, `allowedCheckIds`, P&L facts | `deepCheckVins`, `skipVins`, `checkIds`, `note` | 16s; ≤3 deep VINs, ≤4 checks |
| `resale_pick` | Best flip VIN + shopper action | allowlisted VINs + computed profit/ROI/comps | `pickVin`, `action`, `note`, `evidenceIds` | 14s; pickVin allowlisted |
| `resale_challenge` | Agree or revise pick | primary pick + allowlists | `agrees`, `pickVin`, `action`, `objection`, `evidenceIds` | 14s; revise only to allowlisted VIN |
| `verdict_decide` / `verdict_challenge` | Shared shopper action path (also used when a ComputedReport is built for the pick) | report facts / gates | action + challenge | Existing Check/report limits |
| `radar_review` | Alert vs skip for **NEW** radar listings only | allowlisted VINs + P&L | `decisions[{vin,verdict,note}]` | 14s; bounded per cron run |

## Call budget

- Resale search: hard cap **6** paid SERV calls per delivered search (`RESALE_SERV_CALL_CAP`).
- Deal Radar cron: bounded separately (≤3 review calls per watch run unless documented otherwise).

## Evidence validation (code)

Module: `src/domain/resale-serv-validate.ts`

1. Every VIN / URL / evidence id in SERV output must appear in the input bundle.
2. Free-text numbers must pass `quotedNumbersStayIn` against computed facts.
3. Failures → journal step with `rejected: "rejected: unsupported reference"` + deterministic fallback.
4. Adversarial unit tests mock SERV inventing VINs/prices — must reject.

## Decision journal

Schema: `lemonless.resale_journal.v1` (`src/domain/resale-decision-journal.ts`).

Each step: actor (SERV|code), decided, why, inputsUsed, changed (pick revisions highlighted), model, responseId, timestamp, rejected (if any).

Shown on Resale results and every Deal Radar activity entry.

## Honesty

- No seeded fake listings or alerts.
- Unknowns stay explicit (`unknown`, never a silent default as fact).
- Fee/recon estimates labeled with basis.
- Mocks test-only.
