# Resale / Telegram honesty audit

Branch: `cursor/resale-telegram-honesty-9807`, synced with main through `5708861` (PR #105 Find prefill and PR #104 check sign-in). Shared price math remains `evaluateListingPrice`.

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
| `/check`, `/find` intake | **Kept from main** | Sign-in gates and note prefill stay. Find no longer offers Deal Radar alerts or a Radar sentence while that flag is off. |

## Env flags (names only)

- `RESALE_EVALUATE_ENABLED` — default ON; explicit `false`/`0`/`off` disables `/resale`
- `DEAL_RADAR_UI_ENABLED` — default OFF
- `TELEGRAM_UI_ENABLED` — default OFF (independent of `TELEGRAM_BOT_*`)
- `SCOUT_UI_ENABLED` — default OFF (unchanged)
- Existing bot vars remain: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`

## Screenshots

`docs/screenshots/resale/` — home, `/resale` sign-in gate, `/radar` gated unavailable (390 / 1280 / 1920).

## Review

- Footer, report, developer, and Find alert links follow the runtime flags. Deal Radar, Scout, and Telegram are not in nav when those flags are off.
- Pricing does not start a Radar subscription while Deal Radar is off.
- `/resale` searches the same model-year window as the shared price math, used cars only. A low ask is not copied into the resale range. Unknown accident history is labeled as an example of 1 accident, not a known count.
- Sign-in stays in front of `/resale`, `/find`, and `/check`.
