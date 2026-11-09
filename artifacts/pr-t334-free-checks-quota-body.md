## Summary

Implements owner business rules **327–332 / t334**: **all Find searches are paid** (1 report credit); **3 free vehicle CHECKS per verified Auth.js account per UTC month** (VIN or own listing URL), then paid credits; **mandatory real auth** before checks; **no SERV decision-count cap**; Stripe **test-mode** with livemode fence; no cloud hosted SERV/payments.

Auth.js durable ownership ported from open **PR54** onto `origin/main` @ `17bc818` — **not** a blind merge of the old branch tip.

## Pins

| Item | Value |
|------|--------|
| Base | `origin/main` @ `17bc81839595c627de7ffead5c1ac5b28176d7af` (PR #81 / `17bc818`) |
| Branch | `cursor/t334-free-checks-quota-ecfd` |
| Implement tip | `62ab50a7991ca84cc2bff1d7dff6fde92dee862c` / tree `b7beb3e1ae2c761a3d73a171fb45b220e7fcf7f9` |
| Branch HEAD | `b29802b5508a235f2d7c384a045c309430c09299` / tree `ff35a73e4347cc543c623a419939a8ca48e74b0a` |
| Typecheck / tests | `npm run typecheck` + `npm test` — **796 passed** |
| Default Mini / Fable / SERV models | **unchanged** (no model/env publication) |

## Architecture

```
Auth.js (Google / email) → verified account id
  ├─ POST /api/check          → auth required; preview (no free-check / no credit)
  ├─ POST /api/report check   → reserve free slot → assemble → commit|release
  │                              exhausted → 1 report credit (existing packs)
  ├─ POST /api/match (Find)   → 1 credit (new search); rematch w/ owned token free
  └─ Stripe webhook           → signature + paid + sk_test_ only; livemode refused
```

- Free-check KV: `free-check:quota:{accountId}:{YYYY-MM}` with per-user-month lock
- Lifecycle: **reserve → genuine completed deliverable → commit**; failures **release** (no double-burn)
- Find next-check / free-gov rematches are **not** user checks
- Report credit claims / findctx idempotency **preserved**
- Fail closed if `AUTH_*` / Upstash missing on hosted money/auth paths

## Auth provider deploy checklist (parent — no secrets)

| Env | Status |
|-----|--------|
| Upstash | Present |
| `AUTH_SECRET` | **Absent** — required |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | **Absent** (optional if email used) |
| `NEXT_PUBLIC_FIREBASE_API_KEY` / `AUTH_DOMAIN` / `PROJECT_ID` / `APP_ID` | **Absent** — set all four for email link, or skip email |
| SMTP / `EMAIL_SERVER` / `AUTH_EMAIL_MODE` | **Removed** — do not set |

Until configured: login CTAs stay inactive; checkout + vehicle checks fail closed. Cloud agent did **not** invent secrets, write env, send mail, or buy services.

## Tests (negative / concurrency)

- Free quota: cap 3, idempotent reserve/commit, release on failure, concurrent reserve ≤ 3, UTC month reset
- Report route: auth required, free path no debit, assemble fail releases, exhaust → `credits_required`
- Find search credit: debit once per key, compensate on release, zero balance denied
- Stripe: bad signature / unpaid / invalid user / **livemode refused** / duplicate grant once
- Existing find-handoff + analysis idempotency suites updated for `ledgerOwnerId` / auth mocks

## Business copy

Find is paid; 3 free monthly VIN/URL checks for signed-in accounts; UTC reset date in UI copy; credits page reflects Find + free checks.

## Out of scope / remaining gaps

- **No merge / deploy / hosted SERV / Stripe purchase** from this agent
- Parent must add auth provider env + live-verify sign-in before production auth traffic
- Parent sole coordinator for real SERV inference costs
- Independent review required before merge
- Manual Check UUID double-spend residual (pre-existing P1) unchanged

## Honesty

Offline mocks are **not** live Autodev/SERV/Stripe/OAuth proof. No fake cars/Graph/Fable. Unknown condition data stays honest.
