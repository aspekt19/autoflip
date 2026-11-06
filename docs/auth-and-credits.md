# Auth, credits, and durable ownership

## Current-state findings (pre-auth audit)

| Concern | Actual behavior |
| --- | --- |
| Balance storage | Server KV key `credits:ledger` (Upstash Redis when configured, else local `.data/kv.json`). **Not** cookies, localStorage, or JWT. |
| Browser cookie `af_uid` | Anonymous identity only. Clearing cookies orphans the old UUID’s ledger (data remains in KV, unreachable). |
| Stripe success redirect | UI only. Credits are granted only by signed `POST /api/stripe/webhook` with idempotency `stripe:{event.id}`. |
| Prior identity | No Google/email accounts. Demo uses shared `demo-shared`. |

## What this change adds

- **Auth.js (`next-auth` v5)** with Google OAuth + passwordless email (Nodemailer), database sessions via a **KV adapter** on the existing Upstash/file store (no new paid DB).
- Canonical ledger owner = Auth.js `user.id` (UUID) when signed in; anonymous cookie remains for search and legacy browser credits.
- **Checkout / billing portal require** a verified signed-in session. Missing auth config → **503 fail-closed** (does not pretend auth works).
- **Migration**: `POST /api/account/claim` with `mode=browser` (must still hold `af_uid`) or `mode=purchase` (Stripe paid session + receipt email matches verified account email). Never grants from typed email alone.
- Google↔email linking uses Auth.js + Google `email_verified` proof — not bare email string matching from the client.

## Integration touches (PR53 isolation)

**Intentionally not edited (PR53 / branding):** `Header.tsx`, logo, home/find search flow, `AssistantFlow.tsx`, match/need/assemble find paths.

**Touched for ownership wiring:** credits + plans checkout/portal, account API, report/favorites/radar/agent-key routes (use `ledgerOwnerId()`), reports/favorites copy, footer Account link, small `.auth-*` CSS reuse of existing sheet styles.

**Suggested follow-up (separate PR):** optional Header “Account” link beside credits — not done here to avoid nav/branding conflicts.

## Environment names (no secret values)

| Name | Purpose |
| --- | --- |
| `AUTH_SECRET` | Auth.js signing secret (required) |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | Google OAuth |
| `EMAIL_SERVER` / `EMAIL_FROM` | SMTP magic links |
| `AUTH_EMAIL_MODE=test` | Stub inbox in KV (`auth:test-inbox:{email}`) — tests only |
| Existing | `STRIPE_*`, `UPSTASH_REDIS_REST_*`, `NEXT_PUBLIC_APP_URL` |

Google callback URL: `{NEXT_PUBLIC_APP_URL}/api/auth/callback/google`

## Live setup still required (not done in this PR)

1. Generate `AUTH_SECRET` (`npx auth secret`).
2. Create Google Cloud OAuth client; set redirect URI; set `AUTH_GOOGLE_*`.
3. Configure SMTP (`EMAIL_SERVER`, `EMAIL_FROM`) for real magic links — or keep `AUTH_EMAIL_MODE=test` only in non-prod.
4. Ensure Upstash is set on Vercel so auth users + ledger survive deploys.
5. Stripe test webhook forwarding unchanged; live Stripe keys remain refused.

**Not claimed:** real Google OAuth or production email delivery end-to-end. Those need the credentials above. Unit/integration tests use KV stubs and mocks only.

## Non-destructive deployment / migration plan

1. Merge after security/test review — **no production deploy from this agent**.
2. Set auth env vars on preview first; confirm `/login` and fail-closed checkout without secrets.
3. Deploy with Upstash already populated — **do not wipe** `credits:ledger` or `auth:*` keys.
4. Existing anonymous balances remain under old UUIDs. Users who still have the cookie can claim via Account → “Move this browser’s credits”. Users who lost the cookie but have a paid Stripe receipt can claim via `mode=purchase` once signed in with the matching verified email.
5. Never run a job that zeros balances or bulk-merges by email.

## Security properties covered by tests

- Cookie-cleared login recovers same ledger/reports (account id in KV).
- Browser claim idempotency; second account cannot hijack.
- Purchase claim rejects email mismatch; accepts matching verified receipt email.
- Attacker cannot list/favorite another account’s reports; spend gated by session owner equality.
- Webhook rejects bad/missing signatures; duplicate/concurrent/replay grants once; unpaid/invalid metadata ignored.
- Unconfigured auth / missing session / unverified email denied for paid access.
