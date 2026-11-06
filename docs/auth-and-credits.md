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
- **No dangerous email auto-linking** (`allowDangerousEmailAccountLinking: false`). Email magic-link recovers via Auth.js email lookup; Google does not merge into an existing email user solely because addresses match.
- **`AUTH_EMAIL_MODE=test` is unavailable in production** (hard refuse even if set).
- **Hosted money/auth paths require Upstash**; file/memory fallback is refused on Vercel/production for checkout, claim, auth routes, and Stripe webhooks.

### Claim security (hardened)

| Attack | Mitigation |
| --- | --- |
| Attacker posts arbitrary UUID as `fromUserId` | Route ignores body ids; browser claim uses **httpOnly `af_uid` cookie only**; body `fromUserId`/`userId` → 400 |
| Guess uninitialized UUID | Claim requires ledger `initialized` (`creditSeen`) |
| Concurrent browser claims | Distributed lock + durable claim record before transfer |
| Stripe receipt replay / concurrent accounts | Atomic `auth:purchase-claim:{sessionId}`; second account → `purchase_already_claimed` |

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

## Live / preview configuration status (read-only inspection)

Inspected without printing secret values:

| Signal | Result |
| --- | --- |
| Live `GET /api/account` → `storage` | **`upstash`** (persistent KV already in production — reusable for auth) |
| Live Stripe test checkout | Configured (anonymous checkout still live until this PR deploys) |
| Vercel CLI / Vercel MCP in this agent | **Logged out / needsAuth** — cannot list or set project env NAMES |
| GitHub Actions secrets/variables API | 403 for this integration |
| `AUTH_*` / `EMAIL_*` / `AUTH_GOOGLE_*` in agent shell | **Not present** |

Therefore: **Upstash is already provisioned for Lemonless production.** Google OAuth client credentials and SMTP sender for Lemonless **could not be confirmed** from sanctioned read-only tools in this environment. Creating a Google OAuth client and/or SMTP mailbox requires the account owner (identity / provider signup) — not something this agent can complete without Vercel write access and user OAuth consent.

### Safe agent steps already done

- Security hardenings for claim/linking/test-mode/KV guard (this PR)
- Fail-closed paid paths; no production auth deploy

### Minimal remaining user setup (unavoidable)

1. **Vercel project env** (Dashboard → autoflip / Lemonless project → Environment Variables), preview first — **do not enable production auth traffic until review**:
   - `AUTH_SECRET` — generate with `npx auth secret` or `openssl rand -base64 32`
   - If Google sign-in desired: `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` from a Google Cloud OAuth **Web** client with redirect `{preview-or-prod-url}/api/auth/callback/google`
   - If email sign-in desired: `EMAIL_SERVER`, `EMAIL_FROM` (real SMTP). **Do not set `AUTH_EMAIL_MODE=test` on production**
2. Confirm existing `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` remain set on preview+production (already evidenced on live).
3. Optional: authenticate Vercel MCP / CLI for the agent so future runs can verify env **names** only.

**Not claimed:** real Google OAuth or production email delivery end-to-end. Tests use KV stubs/mocks only.

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
