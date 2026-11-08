# Auth, credits, free checks, and durable ownership

## Product rules (t334 / business 327–332)

| Surface | Cost |
| --- | --- |
| **Find / search** (`POST /api/match`) | **Always 1 report credit** for a new Show-cars search. Owned next-check rematches (`searchContextToken`) do **not** debit again. |
| **Vehicle CHECK** (VIN or shopper-own listing URL → full report) | **3 free / verified account / UTC calendar month**, then **1 report credit** each. |
| **Price preview** (`POST /api/check`) | Requires verified sign-in; **does not** spend a credit or burn a free check. |
| **Find → full analysis** | Always **1 report credit** (existing claim / idempotency fences). Not a free check. |
| **Find next-check / free-gov rematches** | **Not** user checks; **no** free-check burn; **no** SERV decision-count cap. |
| **Stripe** | **TEST mode only** (`sk_test_`). Unlimited test pack purchases for validation. Livemode webhook events **never** grant credits. |

Canonical credit packs remain in `CREDIT_PACKS` (`src/domain/assumptions.ts`) — do not invent prices.

## Auth.js (ported from PR54 — not blind-merged)

- **Auth.js (`next-auth` v5)** with Google OAuth + passwordless email (Nodemailer), database sessions via a **KV adapter** on the existing Upstash/file store (no new paid DB).
- Canonical ledger owner = Auth.js `user.id` (UUID) when signed in; anonymous cookie remains for Find credit spend / legacy browser credits.
- **Checkout / billing portal / vehicle checks require** a verified signed-in session. Missing auth config → **503 fail-closed**.
- **Migration**: `POST /api/account/claim` with `mode=browser` (httpOnly `af_uid` only) or `mode=purchase` (Stripe paid session + receipt email matches verified account email).
- **`AUTH_EMAIL_MODE=test` is unavailable in production** (hard refuse even if set).
- **Hosted money/auth paths require Upstash**; file/memory fallback is refused on Vercel/production.

### Claim / quota security

| Attack | Mitigation |
| --- | --- |
| Cookie clear to reset free checks | Free-check keys are Auth.js account ids only; anonymous UUID cannot open checks |
| Arbitrary UUID claim | Browser claim uses **httpOnly `af_uid` only**; body ids → 400 |
| Concurrent free-check races | Per-user-month lock + reserve/commit/release lifecycle |
| Failed report double-burn | Release reservation on assemble/422/persist failure; commit only after durable save |
| Stripe receipt replay | Idempotency `stripe:{event.id}`; purchase claim one-shot |
| Livemode grant on test deploy | Webhook refuses `livemode: true`; Stripe client refuses non-`sk_test_` keys |
| Dangerous email auto-link | `allowDangerousEmailAccountLinking: false` |

## Environment names (no secret values)

| Name | Purpose |
| --- | --- |
| `AUTH_SECRET` | Auth.js signing secret (**required**) |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | Google OAuth |
| `EMAIL_SERVER` / `EMAIL_FROM` | SMTP magic links |
| `AUTH_EMAIL_MODE=test` | Stub inbox in KV — **local/CI only** |
| Existing | `STRIPE_*` (test), `UPSTASH_REDIS_REST_*`, `NEXT_PUBLIC_APP_URL` |

Google callback URL: `{NEXT_PUBLIC_APP_URL}/api/auth/callback/google`

## Parent auth provider deploy checklist (no secrets)

Confirmed gaps from PR54 inventory (project **autoflip** `prj_FoxThC1FNiYM7300EQthhAlOaDzQ`):

| Item | Status |
| --- | --- |
| Upstash URL/TOKEN | Present (prod + preview) |
| `AUTH_SECRET` | **Absent** — parent must add |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | **Absent** — parent must add (or skip Google) |
| `EMAIL_SERVER` / `EMAIL_FROM` | **Absent** — parent must add (or skip email) |
| Auth/email marketplace connectors | None in reachable scope |
| Never set `AUTH_EMAIL_MODE=test` on production | Required |

Until at least one real provider + `AUTH_SECRET` are present:

- `/login` must not advertise inactive Google/email as working
- Checkout, free monthly checks, and VIN/URL full checks **fail closed**
- This cloud agent does **not** invent mail/SSO secrets, write env, sign up paid services, or send real messages

### Minimal remaining setup (parent/operator)

1. Preview env: `AUTH_SECRET` + Google and/or SMTP.
2. Register Google callback URL.
3. Never `AUTH_EMAIL_MODE=test` on production.
4. Live-verify sign-in on preview before any production auth deploy.
5. Keep Upstash; do not wipe `credits:ledger`, `auth:*`, or `free-check:*` keys.

## Free-check lifecycle (server)

```
reserve(idempotencyKey) → assemble → charge gate
  success + persist → commit (counts toward 3)
  failure / 422 / persist miss → release (slot restored)
```

UTC month key `YYYY-MM`; UI shows reset as `1 <Month> <Year> (00:00 UTC)`.

## Non-destructive plan

1. Independent review → merge only after parent sequence (this agent does not merge/deploy).
2. No hosted SERV / provider / credit purchase from this cloud agent.
3. Stripe remains test-mode validation only.
