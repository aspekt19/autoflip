# t308 — Supported free TEST credit acquisition path (repo-only)

**SHA:** `06f8bad3d03402662fd821f8617aff3c5b51c891`  
**Tree:** `ca6f9baad8ea3010d9a59a075a6e5f8294ca311d`  
**Scope:** code + UI copy + env gates only. No purchases, no Stripe/webhook calls, no credit grants, no production browse-to-buy.

---

## Verdict for parent Flip (ASAP)

| Question | Answer |
| --- | --- |
| Is simulated / no-money purchase **legitimately intended**? | **Yes.** Credits + Pricing are explicitly **Stripe test mode** preview surfaces. |
| Can the designed path cause **external live payment** (real money)? | **No, if used as designed with repo gates.** `stripeClient()` **refuses any non-`sk_test_` secret key**. Live `sk_live_` keys never create a Checkout session. UI copy instructs test card `4242…`. |
| Safe for Flip’s sole live journey once credits exist? | **Yes for acquiring test credits via test checkout** (no real charge). Still **spends real Autodev/SERV quota** on Find match / full analysis afterward — that is separate from Stripe money. |
| Should this agent grant credits / buy / call APIs? | **No** (forbidden). Parent Flip uses this path or an existing browser `af_uid` session. |

---

## How identity & credits work (`af_uid`)

| Piece | Behavior |
| --- | --- |
| Cookie | `af_uid` — `httpOnly`, `sameSite=lax`, `path=/`, 1-year maxAge; `secure` in production (`src/server/session.ts`) |
| Value | UUID v4 **or** literal `demo-shared` |
| Mint | First server call that needs `userId()` sets a new UUID if cookie missing/invalid |
| Balance | Kv ledger via `credit-book` (`balanceOf` / `creditSpend` / `creditGrant`) |
| Initial seed | `AUTOFLIP_DEV_CREDITS` — if unset/empty/`≤0` → **0 credits** on first account (`ensureAccount`) |
| Demo seed | `DEMO_CREDITS` (default **5**) daily refill for `demo-shared` only (`ensureDemoAccount`) |
| Cross-device | **No.** Cookie-bound; no login. New browser / cleared cookies = new empty account. |
| Header `+/credits` | Reads `GET /api/account` → shows ledger balance for current `af_uid` |

**Parent Flip alternative (preferred when available):** reuse an **existing normal-browser session** that already has `af_uid` + credits. Do **not** open a fresh Incognito (visual Incognito on published 06f8bad showed **0 credits** — expected with default seed). Inspect DevTools → Application → Cookies → `af_uid`; Header balance confirms credits before Find→Full analysis.

---

## Path A — Normal UI “Buy in test mode” (primary supported free-of-real-money path)

**Gates (all must hold):**

1. `STRIPE_SECRET_KEY` set and **starts with `sk_test_`** (`src/server/stripe.ts`). Otherwise checkout returns **503** `stripe_unconfigured` and Credits UI shows “Stripe test keys are not configured”.
2. Live keys refused: `!key.startsWith("sk_test_")` → error *"Only Stripe test keys are accepted. Live keys are refused."*
3. Webhook path: `STRIPE_WEBHOOK_SECRET` needed for `checkout.session.completed` → `grantCredit(user, credits, stripe:{event.id})` (`src/app/api/stripe/webhook/route.ts`). Without webhook delivery, balance may stay 0 after redirect success copy.
4. Packs: `CREDIT_PACKS` in `src/domain/assumptions.ts` — `pack_3` ($9 / 3 credits), `pack_10` ($25 / 10 credits). Non-zero `amountCents` (not price=0); money is **test** Stripe charge only.

**Exact UI steps (designed):**

1. Open site in a **persistent** browser (not a throwaway Incognito if Flip needs the same session later).
2. Go to **Credits** (`/credits`) via Header `+/credits` or footer.
3. Confirm kicker **“Test checkout”** and hint: *Stripe test mode… 4242 4242 4242 4242…*
4. Click **“Buy in test mode”** on a pack (button label; not live Checkout wording).
5. App `POST /api/credits/checkout` with `{ pack, returnTo? }` → Stripe Checkout **test** session URL → redirect.
6. Pay with Stripe **test** card `4242 4242 4242 4242`, any future expiry, any CVC.
7. Return to `/credits?status=success` (+ optional `return=`). Wait for webhook; refresh until Balance ≥ needed credits.
8. Optional: Pricing `/pricing` is the same test-mode story for **Radar plans** (subscriptions), not report credits.

**External payment risk:** Stripe API is called, but only with **test** keys. Designed path does **not** take real money. Misconfiguration with a live key is **blocked in code**. Operator still must not paste live keys into this preview env.

**Not a “mock purchase”:** there is no in-app `price=0` / mock grant button for anonymous users. The legitimate no-real-money path **is** Stripe test Checkout + webhook grant.

---

## Path B — Shared demo account (key-gated; not anonymous)

| Gate | Detail |
| --- | --- |
| Entry | `GET /demo?key=…` (`src/app/demo/route.ts`) |
| Secret | `DEMO_ACCESS_KEY` must match (`secretMatch`); else **401** |
| Effect | Sets `af_uid=demo-shared`; `ensureDemoAccount` refills to `DEMO_CREDITS` (default 5) once per UTC day |
| Redirect | `/radar` |
| Caveat | **Shared** credits/reports/favorites across demo visitors — Credits page warns. Unsuitable as Flip’s private sole-journey account unless parent accepts shared ledger. |

---

## Path C — Dev seed (env only; not normal consumer UI)

- `AUTOFLIP_DEV_CREDITS=<positive int>` seeds **new** UUID accounts on first `userId()` / `ensureAccount`.
- Not advertised in Credits UI; deployment-config only.
- Does not create Stripe charges.

---

## What is **not** a free credit path

- Homepage / Find / Check / sample report do **not** grant report credits.
- Scout grant is a **separate** owner-gated budget (not report credits).
- Empty Incognito on published preview with default seed → **0 credits** (matches visual finding).
- Calling `/api/credits/checkout` without test Stripe configured → 503, no grant.

---

## Recommendation for parent Flip’s sole live Find→Full analysis

1. **Preferred:** existing browser session with nonzero Header credit balance (`af_uid` already set).
2. **Else:** Path A test Checkout in that same browser (test card; confirm Balance > 0 before Full analysis).
3. **Avoid:** new Incognito; Path B demo unless shared account is acceptable.
4. **Do not** ask this scoped-fix agent to purchase, grant, or burn Autodev/SERV.

---

## Files referenced

- `src/app/credits/page.tsx` — Test checkout UI
- `src/app/api/credits/checkout/route.ts` — Checkout session create
- `src/server/stripe.ts` — `sk_test_` only
- `src/app/api/stripe/webhook/route.ts` — credit grant on completed checkout
- `src/server/session.ts` — `af_uid`, seed, ledger helpers
- `src/app/demo/route.ts` + `src/server/radar-store.ts` `ensureDemoAccount`
- `src/domain/assumptions.ts` — `CREDIT_PACKS`
