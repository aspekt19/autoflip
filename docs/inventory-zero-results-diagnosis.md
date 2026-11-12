# Inventory zero-results diagnosis

Runs examined (prod permalinks via public `GET /api/run/<id>`):

| Run | Kind | Limits | Published outcome |
|---|---|---|---|
| `run_5a2d5f63f8fb41dc92ca` | resale | Budget $8,000 · 100 mi of 75201 · Sell within 30 days | **Finished** with **5 listings**, pick Civic, verdict **pass** (margin $202 &lt; $1,500 floor). Not an empty inventory today. |
| `run_e5202250c399449398b3` | find | Budget $11,000 · 100 mi of 43215 · note: college / safe / cheap on gas / automatic only | **Stopped** after `search_listings` with `failureReasons: ["no_cars"]`, **0 listings**. |

Live Auto.dev re-queries from this agent VM could not use the production key (Vercel MCP does not decrypt sensitive envs; Auto.dev dashboard requires interactive Google password). Funnel counts below combine (a) the public run payloads, (b) the committed Camry fixture, (c) reconstructed query URLs from `listingsSearchUrl` / Find-match, and (d) prior fix #178.

Re-run live counts when a key is available:

```bash
AUTODEV_API_KEY=… npx tsx scripts/diagnose-inventory-funnel.ts
```

## Filter funnel (order)

### Find (Columbus)

1. Auto.dev `/listings` (`listingsSearchUrl` → `autodevSearch` → `parseAutoDevListings`)
2. Passenger / light-truck gate (`isPassengerOrLightTruck`)
3. `enforceHard` (price, year, miles, radius, excluded makes, accidents, AWD, body)
4. `listingWithinNeed` (preferred makes, miles, note body)
5. `admitFindListingForBudget` (missing ask dropped; &gt;5% over budget dropped)
6. Implausible odometer hide + VIN dedupe + diversify-to-8

**Not provider filters today:** transmission, fuel, listing age / 30-day window.  
**Intake only:** `automatic only` → `transmission: "automatic"` (never sent to Auto.dev; was also **dropped** from normalized `Listing` until this PR).  
**Soft:** `cheap on gas` → fuel-economy priority / commute use-case (widens models; does not hard-filter fuel).

### Resale / flip (Dallas)

1. Same Auto.dev fetch with `price.asc`, miles `0–180000`, price `1–budget×1.05`
2. `postFilterFlipInventory` (price ceiling, mile cap, salvage/flood, radius)
3. Rank / PnL / sell-window (post-inventory economics)

## Which filter zeros inventory?

### Columbus (`run_e5202250c399449398b3`) — true empty

**Primary data-layer emptier (when the plan sets a car body):** `vehicle.bodyStyle=Sedan` (or Coupe / Hatchback / Wagon / Convertible).

Evidence from `fixtures/autodev-camry.json` (live-shaped Camry page):

| Step | Remaining |
|---|---|
| Raw fixture rows | 5 |
| `vehicle.bodyStyle === "Sedan"` | **0** |
| `vehicle.bodyStyle === "Car"` | 5 |
| After `providerBodyStyleParam("Sedan")` (omit) | 5 kept for local matching |

Feed shape: `bodyStyle: "Car"` with `style`/`type`/`series` saying Sedan. Local `bodyStyleMatches("Sedan", { bodyStyle: "Car", style: "Sedan" })` is true — the bug is **only** on the provider query string.

#178 already stopped comma-joined passenger lists (`Sedan,SUV,…`). A **single** `Sedan` from `bodyStyleForQuery` / `findBodyStyleParam` was still sent. SERV plans for efficient college / first-car notes routinely set sedan directions, so Columbus-style searches still hit this.

Reconstructed URLs (budget $11k × 1.05 = 11550, ZIP 43215, 100 mi):

```
# Pre-fix (zeros Car-tagged inventory)
…/listings?vehicle.make=Toyota&vehicle.model=Corolla&vehicle.bodyStyle=Sedan&retailListing.price=1-11550&zip=43215&distance=100&limit=20

# After this PR (Sedan omitted at listingsSearchUrl)
…/listings?vehicle.make=Toyota&vehicle.model=Corolla&retailListing.price=1-11550&zip=43215&distance=100&limit=20
```

**Not the emptier:** automatic transmission (never applied), fuel (soft), ZIP (43215 resolves), radius (explicit 100).  
**Secondary risk without live key:** even with Sedan omitted, a first wave of hybrid/commuter models under $11k within 100 mi can still return a thin page — `search_listings` should report per-query counts so SERV can relax price/radius/models.

### Dallas (`run_5a2d5f63f8fb41dc92ca`) — not empty inventory on the published run

Public payload **already has 5 cars**. Closest pick: 2012 Civic @ $5,701 / 118,593 mi, **$202** under comps after costs → **pass** because margin &lt; $1,500. High-mileage copy is explanation, not a hard wipe.

Historical “0 cars” for Dallas-shaped resale (documented in #178): **30-day sell window applied as a hard inventory delete** → `no_cars`. That path was changed so window misses stay listed and are not recommended. Current run matches the post-fix behavior (cars present, economics pass).

Fixture / code funnel for a Dallas-shaped flip query (`price 1-8400`, `miles 0-180000`, `zip 75201`, `distance 100`, `sort price.asc`):

| Step | Role |
|---|---|
| Provider page | Up to 20 rows / model |
| `postFilterFlipInventory` | Drops no/invalid price, &gt; budget×1.05, &gt; 180k mi, salvage/flood, outside radius |
| Rank / sell-window / margin | Can leave **no recommended flip** without deleting the list |

## Data-layer fixes in this PR

1. **`providerBodyStyleParam`** — omit car-family styles on Auto.dev queries (centralized in `listingsSearchUrl`).
2. **`transmission` pass-through** on `normalizeAutoDevListing` — feed already has `vehicle.transmission`; Listing dropped it, so an agentic `search_listings` tool could not filter or relax “automatic only”.

No SERV / Find-match / resale pipeline rewrites.

## Recommendations for `search_listings` tool (SERV agentic loop)

**Inputs (explicit, relaxable):**

| Param | Notes |
|---|---|
| `make` / `model` | One model per call (or documented multi-model behavior) |
| `yearMin` / `yearMax` | Provider year range |
| `priceMaxUsd` | Tool applies provider soft ceiling (e.g. ×1.05) and returns both |
| `milesMax` | Optional |
| `zip` + `radiusMiles` | `null` radius = nationwide; never invent 100 |
| `bodyFamily` | `car` \| `suv` \| `truck` \| `van` \| omit — **never** send Sedan to Auto.dev |
| `transmission` | `automatic` \| `manual` \| omit — filter **after** fetch using normalized field |
| `fuel` / `drivetrain` | Prefer post-filter; drivetrain query param is unreliable |
| `usedOnly` | Optional `retailListing.used` |
| `limit` / `page` / `sort` | Cap page size; return `truncated: true` when page full |

**Return shape (so SERV can relax intelligently):**

```ts
{
  query: { /* echoed, including provider URL params actually sent */ },
  totalReturned: number,
  funnel: [
    { step: "provider_raw", count },
    { step: "normalized_vin_ymm", count },
    { step: "passenger_gate", count },
    { step: "transmission", count },
    { step: "body_family", count },
    { step: "price", count },
    { step: "miles", count },
    { step: "radius", count },
  ],
  listings: [ /* include transmission, bodyStyle, style, distanceMiles, createdAt, fuel, drivetrain */ ],
  relaxHints: ["omit_body", "widen_radius", "raise_price", "drop_transmission", "next_model"],
}
```

**Rules of thumb for the agent:**

1. If `provider_raw=0` and a car body was requested → retry **without** body (or with family omit) before widening budget.
2. If `provider_raw>0` but transmission/body post-filters → 0 → surface those steps; do not claim “no cars near ZIP”.
3. Sell-within-N-days and profit floor are **ranking / verdict** constraints, never silent inventory deletes.
4. Always return the funnel counts in the tool result so empty outcomes are attributable.
