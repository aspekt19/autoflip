# t309 — Find Full analysis `find_context_invalid` on fresh Gateway Mazda card

## Pins (verified before fix)

| Ref | OID | Tree |
| --- | --- | --- |
| Production main (PR74) | `06f8bad3d03402662fd821f8617aff3c5b51c891` | `ca6f9baad8ea3010d9a59a075a6e5f8294ca311d` |
| Prior PR75 ACCEPT head | `f2d25f3f5c03d6b3a9fe0f4fc8c191b6c212dd01` | `58b2c55805feb44f03f0663d54c61a3038aafa72` |
| PR75 remote before this commit | same as ACCEPT — **no drift** | |
| New PR75 head (t309) | filled after push in this file's CI section |

**Prior ACCEPT of `f2d25f3` is ACCEPT of old head only — re-review required for t309.**

PR75 is **not published**. Owner authorized diagnose+fix + test purchase/report; not new publication.

## Incident facts (public)

- Find: Reliable used SUV · $20k · ZIP **68114** · radius **50** → 8 cards
- Card: **2016 Mazda CX-5 Touring** · ask **$15,995** · miles **94,057** · Omaha NE · Good price
- VIN `JM3KE4CY7G0753111`
- VDP `https://www.gatewayautosalesomaha.com/inventory/used-2016-mazda-cx-5-touring-sport-utility-4d-jm3ke4cy7g0753111-in-omaha-ne`
- Immediate Full analysis → exact UI: *That find result is no longer trusted for full analysis… No credit was charged.*
- Balance 3 unchanged; no report ID

## Root cause (evidence)

Error string is `INVALID_MSG` from `verifyFindAnalysisContext` (`src/server/find-analysis-context.ts`) returned by `/api/report` when verification fails (`src/app/api/report/route.ts`).

**Concrete failure reason: `tampered_facts` on ZIP.**

1. Autodev listings carry **dealer** `retail.zip` (`src/io/parsers.ts` → `zip: str(retail.zip)`).
2. Mint stored `listing.zip ?? needZip` (`mintFindAnalysisContextRecord`) — **dealer ZIP won** when present.
3. Card CTA handoff claims **search** ZIP via `need.zip || car.zip` (`resolveSelectedListingHandoff` / `buildPayload`).
4. Verify rejects when `claimedZip !== record.zip` (`verifyFindAnalysisContext` ~L219–221).

Search ZIP **68114** ≠ typical Omaha dealer feed ZIP → legit Full analysis refused, 0 charge. Security checks (token/owner/VIN/VDP/expiry/miles) were not the bug; mint/handoff ZIP precedence was inconsistent.

Failure-first offline repro with Gateway public facts failed on current mint order; passed after fix.

## Fix (minimal; checks preserved)

`src/server/find-analysis-context.ts` — mint ZIP binding:

```ts
zip: normalizeZip(needZip) ?? normalizeZip(listing.zip),
```

**Deliberately not weakened:** token required; owner binding; VIN match; exact VDP match; expiry; miles tamper; forged ZIP still `tampered_facts`; no bypass; no URL fetch; HOLD5 once-charge / persist compensation / durable success / fail-closed crash unchanged.

## Tests proving Gateway Mazda case

- `t309 Gateway Mazda: dealer retail.zip ≠ search ZIP still verifies when handoff claims need.zip` — `src/server/find-analysis-context.test.ts`
- `mint prefers find-session needZip over dealer retail.zip` — same file
- `t309 Gateway Mazda handoff claims search ZIP even when card carries dealer zip` — `src/domain/find-analysis-handoff.test.ts`
- `t309 Gateway Mazda CX-5: dealer zip ≠ search zip Full analysis charges once` — `src/app/api/report/find-handoff.route.test.ts`
- `t309 still refuses forged ZIP against find-session binding` — same route file

## Residual risks

- Listings minted before deploy still have dealer ZIP in Kv until Find is re-run (2h TTL on record.exp; advise “Run Find again”).
- Nationwide finds (no needZip) still bind dealer ZIP; handoff then falls through to `car.zip` — OK when card JSON includes zip.
- No live browser / provider / Stripe verification in this agent (parent sole live).

## Scope

PR75 workstream only (`cursor/t307-t308-scoped-fixes-ecfd`). No merge/deploy/env/credentials. TEST checkout receipt remains separate from report data.
