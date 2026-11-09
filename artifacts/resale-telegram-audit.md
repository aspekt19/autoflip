# Resale / Telegram honesty audit

Branch: `cursor/resale-telegram-honesty-9807` (from `2ab0aa6` / PR #103 shared `evaluateListingPrice`).

| Surface | Decision | Why |
| --- | --- | --- |
| `/resale` + `POST /api/resale/evaluate` | **Kept** (default ON via `RESALE_EVALUATE_ENABLED`) | Minimal honest one-car flow: buy ceiling, resale range from shared `evaluateListingPrice` + `flipMath`, fees/recon labeled estimates, margin + High/Medium/Low confidence or “Not enough similar cars.” Sign-in required. No profit guarantee. |
| Nav: Deal Radar | **Hidden** → **Resale** when `DEAL_RADAR_UI_ENABLED` off | Judges would hit half-wired watches/cron/plans. Code kept. |
| `/radar`, `/activity` | **Hidden** (unavailable page; code kept) | Same. Enable with `DEAL_RADAR_UI_ENABLED=true`. |
| Scout UI (`/scout`, nav) | **Hidden** (existing `SCOUT_UI_ENABLED` default off) | Paid/heavy investigation surface; already gated. |
| Telegram Connect UI + `/api/telegram/link` | **Hidden** (`TELEGRAM_UI_ENABLED` default off) | Bot env may exist, but E2E webhook/alerts not verified for this preview. No test messages to real users. Server/webhook code kept. |
| Home “For resale” | **Kept → `/resale`** | Honest CTA; does not send flip mode into Find intake. |
| `/pricing` Radar plans | **Kept** with honest test-mode copy + Resale link | No Stripe/env changes. Notes Deal Radar may be off. |
| Footer Deal Radar link | **Replaced with Resale** | Matches default nav. |
| `/demo` redirect | **Radar if enabled, else Resale/home** | Avoids dead Radar landing when flag off. |
| `/check`, `/find` intake | **Untouched** | PR #104 / #105 in review — conflict avoidance. |

## Env flags (names only)

- `RESALE_EVALUATE_ENABLED` — default ON; explicit `false`/`0`/`off` disables `/resale`
- `DEAL_RADAR_UI_ENABLED` — default OFF
- `TELEGRAM_UI_ENABLED` — default OFF (independent of `TELEGRAM_BOT_*`)
- `SCOUT_UI_ENABLED` — default OFF (unchanged)
- Existing bot vars remain: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`

## Screenshots

`docs/screenshots/resale/` — home, `/resale` sign-in gate, `/radar` gated unavailable (390 / 1280 / 1920).
