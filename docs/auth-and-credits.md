# Auth, credits, free checks, and durable ownership

## Product rules (t334 / business 327–332)

| Surface | Cost |
| --- | --- |
| **Find / search** (`POST /api/match`, Find chat, API v1 / MCP) | **Verified Auth.js account required** + **reserve 1 report credit BEFORE SERV**. Commit on a chosen result; **release** on nothing-fits / error / no car. Balance &lt; 1 → search does not start. Anonymous `af_uid` cannot debit. Owned next-check rematches (`searchContextToken`) do **not** debit again. |
| **Resale search** | Same shared gate as Find (`src/server/search-billing-gate.ts`). Never show unpaid results. |
| **Vehicle CHECK** (listing link fetch, pasted listing text, or VIN dossier via `POST /api/check`, and VIN/URL → full report) | **3 free / verified account / UTC calendar month**, then **1 report credit** each. Free key is **VIN-scoped** (not mode): personal↔flip on the same VIN burns **one** free slot; a second analysis after commit uses credits (`already_completed`). Listing links may be any public URL — Lemonless fetches the page (no login/captcha bypass). |
| **Sign-in gate** (`/check`, `/find`) | Verified sign-in is required **before** the form is shown (not after submit). |
| **Find → full analysis** | Always **1 report credit** (existing claim / idempotency fences). Not a free check. |
| **Find next-check / free-gov rematches** | **Not** user checks; **no** free-check burn; **no** SERV decision-count cap. |
| **Stripe** | **TEST mode only** (`sk_test_`). Unlimited test pack purchases for validation. Livemode webhook events **never** grant credits. |

Canonical credit packs remain in `CREDIT_PACKS` (`src/domain/assumptions.ts`) — do not invent prices.

## Auth.js (ported from PR54 — not blind-merged)

- **Auth.js (`next-auth` v5)** with Google OAuth + Firebase email-link (passwordless). Sessions are **JWT** (required for the Credentials provider). Users still live in the **KV adapter** (no new database, no Firebase Admin service account).
- Canonical ledger owner = Auth.js `user.id` (UUID) for the **lowercased verified email**. Google and email-link for that address share one id, so credits and the free-check quota stay together. Anonymous `af_uid` is **not** a Find or check spend path (legacy cookie balances migrate via claim only).
- **Checkout / billing portal / vehicle checks / billable Find require** a verified signed-in session. Missing auth config → **503 fail-closed**.
- **Migration**: `POST /api/account/claim` with `mode=browser` (httpOnly `af_uid` only) or `mode=purchase` (Stripe paid session + receipt email matches verified account email).
- **Email option** appears only when `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, and `NEXT_PUBLIC_FIREBASE_APP_ID` are all set. Firebase sends the link. ID tokens are checked with `jose` against Google's securetoken JWKS (`email_verified` must be true).
- **Hosted money/auth paths require Upstash**; file/memory fallback is refused on Vercel/production.

### Claim / quota security

| Attack | Mitigation |
| --- | --- |
| Cookie clear to reset free checks | Free-check keys are Auth.js account ids only; anonymous UUID cannot open checks |
| Anon cookie Find debit / id spoof | `requireVerifiedAccountForFind` fail-closed; rematch tokens owned by verified account only |
| Dual free burn personal↔flip same VIN | Free idempotency key omits mode; committed VIN → `already_completed` → paid |
| Arbitrary UUID claim | Browser claim uses **httpOnly `af_uid` only**; body ids → 400 |
| Concurrent free-check races | Per-user-month lock + reserve/commit/release lifecycle |
| Failed report double-burn | Release reservation on assemble/422/persist failure; commit only after durable save |
| Stripe receipt replay | Idempotency `stripe:{event.id}`; purchase claim one-shot |
| Livemode grant on test deploy | Webhook refuses `livemode: true`; Stripe client refuses non-`sk_test_` keys |
| Unverified email takeover | Google sign-in rejected unless `email_verified`. Email-link rejected unless the Firebase ID token has `email_verified: true`. Verified addresses then share one user id. |

## Environment names (no secret values)

| Name | Purpose |
| --- | --- |
| `AUTH_SECRET` | Auth.js signing secret (**required**) |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | Google OAuth |
| `NEXT_PUBLIC_FIREBASE_API_KEY` | Public Firebase web API key (email link) |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | Public Firebase auth domain |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | Public Firebase project id (token `aud` / `iss`) |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | Public Firebase app id |
| Existing | `STRIPE_*` (test), `UPSTASH_REDIS_REST_*`, `NEXT_PUBLIC_APP_URL` |

Google callback URL: `{NEXT_PUBLIC_APP_URL}/api/auth/callback/google`

## Parent auth provider deploy checklist (no secrets)

Confirmed gaps from PR54 inventory (project **autoflip** `prj_FoxThC1FNiYM7300EQthhAlOaDzQ`):

| Item | Status |
| --- | --- |
| Upstash URL/TOKEN | Present (prod + preview) |
| `AUTH_SECRET` | **Absent** — parent must add |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | **Absent** — parent must add (or skip Google) |
| `NEXT_PUBLIC_FIREBASE_*` (four public web values) | **Absent** — parent must add for email link (or skip email) |
| Firebase Admin service account | **Not used** |
| SMTP / `EMAIL_SERVER` / `AUTH_EMAIL_MODE` | **Removed** — do not set |

Until at least one real provider + `AUTH_SECRET` are present:

- `/login` must not advertise inactive Google/email as working
- Checkout, free monthly checks, and VIN/URL full checks **fail closed**
- This cloud agent does **not** invent mail/SSO secrets, write env, sign up paid services, or send real messages

### Minimal remaining setup (parent/operator)

1. Preview env: `AUTH_SECRET` + Google and/or the four `NEXT_PUBLIC_FIREBASE_*` values.
2. Register Google callback URL.
3. Firebase authorized domains must include the preview host. The email link returns to `{origin}/login/finish`.
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
