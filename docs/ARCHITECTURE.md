# Architecture

Lemonless is a used-car decision product. The model (SERV) chooses. TypeScript checks the choice, enforces hard constraints, computes miles and money, and writes the journal. A missing data source never blocks a result; the gap is labeled.

Live app: [autoflip-umber.vercel.app](https://autoflip-umber.vercel.app/). Recorded evidence: [/proof](https://autoflip-umber.vercel.app/proof).

## Find

The shopper path is one chat (`src/server/find-chat.ts` → `src/server/find-agent/loop.ts`).

1. **Intake.** The model asks what is missing. It does not parse the chat in product code.
2. **`submit_brief`.** Budget quote, ZIP, radius, and hard/soft rows. Code checks that the budget quote appears in the transcript.
3. **Confirm gate.** Search tools are refused until the shopper confirms. A checkpoint stores the loop so a long run survives the request limit (`src/server/serv/agent-loop-checkpoint.ts`).
4. **Tools.** `search_listings`, recalls, safety, VIN decode, fuel economy, market comps. Rows come back unfiltered; the model sees an observational funnel and decides what to relax.
5. **Terminal tool.** `submit_picks` or `submit_nothing_fits`. There is no separate published ranker on this path. The decide route maps the loop’s picks onto the shortlist and does not substitute a code-chosen car when the loop fails (`src/server/find-decide-orchestrator.ts`).

Hard checks on `submit_picks` (`src/domain/find-agent.ts`):

- The VIN was returned by a tool.
- Asking price and offer are within the confirmed budget.
- When miles were computed and the shopper set a radius, the car is inside that radius unless they agreed to widen it.
- When the confirmed brief forbids accidents and any source has `accidentCount >= 1` or a salvage or other title brand, the pick is rejected and sent back for repair. It is not the primary pick. The only place that car may appear is as a separate line: “does not meet your no-accident rule.” If nothing clean fits, the finish is `submit_nothing_fits` naming those near misses. Unknown history is allowed and shown as unverified.

Distance (`src/domain/geo.ts`): feed miles, else listing coordinates, else the ZIP lookup, else the bundled centroid table (`src/domain/data/zip-centroids.ts`). A Colorado Springs dealer ZIP (`80903`) is 64 straight-line miles from `80202` on that table. When miles cannot be computed, `radiusCheck` is `unverified` and the page says unverified.

Offer: `openingOffer` and `walkAway` on `submit_picks` are the only offer figures. `src/domain/structured-offer.ts` renders them. The run report, Radar, and Telegram call that renderer. If the prose names an offer and both fields are empty, validation sends the pick back.

## VIN record

`src/domain/normalized-vehicle.ts` merges feed, page, vPIC, fuel, and NHTSA into one record per VIN. Each field keeps its source. Listing links must be `http(s)`. Source attempts are recorded as queried, empty, unavailable, or error. Code does not grade the content, and a missing source does not block the model.

## Check and Resale

Check (`src/server/check/run-check.ts`) prices a single listing in code, then may run a review and a second look when a key is set and the safety gates allow it. Resale uses the same agent loop shape, with code profit on each candidate. Buy or negotiate is rejected when code mid-profit is not positive.

## Billing, Radar, Telegram

Find and Resale reserve one report credit before the model runs and commit it only when a result is delivered (`src/server/search-billing-gate.ts`). Radar plans are in `src/domain/plans.ts`: $100/month, 1 watch, 300 reviews; $250/month, 3 watches, 900 reviews. No free Radar tier. The daily cron re-checks watches. In-app alerts are the record; Telegram (`src/io/telegram.ts`) sends a copy of the same distance and offer text when the bot is configured.

## What this page does not claim

[/proof](https://autoflip-umber.vercel.app/proof) is the comparison. Numbers, winners, and gaps belong on that page and in the files it links. `eval/snapshot/` can score a frozen candidate set twice (verdict features off and on) with no second live search. `npm run eval:snapshot` does not spend credits; a paid run is a later step.

There is no NMVTIS title feed. Stripe is test mode. Listing prices are asking prices, not sold prices.
