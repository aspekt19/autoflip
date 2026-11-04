# AutoFlip

Evaluation preview of a US used-car verdict. Paste a listing URL or VIN, or scan a make and model. AutoFlip says **good deal**, **fair**, **overpriced**, or **walk away**, and shows the arithmetic.

Deal Radar is free. A full report costs 1 credit. Credits are sold with **Stripe test mode** only. Agents can buy the same verdict through MCP and an HTTP endpoint. The consumer pages do not describe that payment rail; the [developer page](src/app/developers/page.tsx) does.

This build is an evaluation preview. The Auto.dev free plan is not a production license.

## What works

- Deal Radar scores each listing against the other listings in the same result (price, mileage, and history flags that are actually present).
- A full report adds NHTSA VIN decode, NHTSA recalls, NHTSA complaint count, fueleconomy.gov, and a Census distance when both ZIPs geocode.
- Personal mode compares the asking price with a mileage-adjusted, history-adjusted fair value.
- Flip mode estimates a resale range from comparable **asking** prices (not closed sales), then subtracts fee and reconditioning assumptions.
- Every dollar, percentage, mileage, and VIN in the written summary is checked against the tool output. A mismatch is replaced by a deterministic template.
- When `SERV_API_KEY` is set, user text is sent through `serv_prompt_guard`, and the explanation is sent through `serv_prompt_guard` plus `serv_shadow_agent`. The Proof of AI block records the steps, an inputs hash, the tool outputs, and the model.
- Auto.dev calls stop at 900 per UTC month and are cached for 6 hours. A stopped month returns a plain “demo limit reached” message and does not call the provider.
- Without `AUTODEV_API_KEY`, Deal Radar and reports for the five fixture VINs use the labeled sample. Other VINs are refused. The sample is never mixed into a live result.
- Stripe Checkout in test mode, with live keys refused. The webhook grants credits once per event.
- MCP (`deal_radar`, `full_report`) and `POST /api/v1/report`. Agent payment is x402: the server returns 402 until a facilitator verifies and settles. An empty payee does not pretend a payment worked.

## What is stubbed, and why

- **MarketCheck** is a disabled adapter (`src/io/marketcheck.ts`). It is not called. The free tier is evaluation-only, and its cache terms do not fit Deal Radar. Leave it off until a written production license exists.
- **Listing URLs are not scraped.** A URL is accepted only when it contains a valid VIN. The VIN is then looked up at Auto.dev.
- **No days-on-market and no NMVTIS title brands.** They are not in the listing fields this app uses, and no second paid history vendor is connected. The report says so.
- **Fuel cost** is the EPA figure from fueleconomy.gov when a configuration matches. AutoFlip does not invent a gas price.
- **SERV** is skipped, and the template is used, when `SERV_API_KEY` is unset. If the key is set and the guard call fails, the request stops instead of skipping the check.
- **Credits, quota, cache, and saved reports** are JSON files (`.data/` locally, `/tmp/autoflip` on Vercel). They are ephemeral on serverless and are not safe for a public launch. Point `AUTOFLIP_DATA_DIR` at durable storage, or replace `src/io/store.ts`, before real customers.
- **Agent payment** is implemented as verify-then-settle against `X402_FACILITATOR_URL`. Nothing is paid from this app. Set `X402_PAY_TO`, `X402_NETWORK`, and `X402_ASSET` when you want agents to pay. The default scheme is `gokite-aa` so a Kite Passport session can pay.
- **Distance** is omitted when the Census geocoder returns no match.

## Setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open http://localhost:3000.

For a local full report without Stripe, set `AUTOFLIP_DEV_CREDITS=3` and restart. That seeds each new browser once. It is not a production balance.

Stripe test card: `4242 4242 4242 4242`, any future date, any CVC. Forward webhooks with the Stripe CLI to `POST /api/stripe/webhook`. Credits appear after `checkout.session.completed`.

```bash
npm run typecheck
npm test
npm run build
```

## Environment

| Variable | Purpose |
| --- | --- |
| `AUTODEV_API_KEY` | Auto.dev free plan. `Authorization: Bearer`. Listings search and `GET /listings/{vin}`. |
| `SERV_API_KEY` | OpenServ SERV Reasoning. |
| `SERV_MODEL` | Default `gpt-5.4-mini`. |
| `SERV_BASE_URL` | Default `https://inference-api.openserv.ai/v1`. |
| `STRIPE_SECRET_KEY` | Must start with `sk_test_`. Live keys are refused. |
| `STRIPE_WEBHOOK_SECRET` | Webhook signature. |
| `NEXT_PUBLIC_APP_URL` | Checkout return URL. |
| `AUTOFLIP_DEV_CREDITS` | Optional local starting balance. |
| `AUTOFLIP_DATA_DIR` | Quota, credits, cache files, reports. |
| `X402_PAY_TO` | Agent payee. Empty means payments are not configured. |
| `X402_SCHEME` | Default `gokite-aa`. |
| `X402_NETWORK` | Network id the facilitator expects. |
| `X402_ASSET` | Asset contract the facilitator expects. |
| `X402_FACILITATOR_URL` | Default `https://facilitator.pieverse.io`. |
| `X402_PRICE_ATOMIC` | Default `1000000`. |
| `X402_DESCRIPTION` | Shown on the payment requirement. |

Do not commit `.env.local`.

## Architecture

```
browser or agent
  → input screen (local) and, when keyed, serv_prompt_guard
  → Auto.dev (cached, monthly cap) or the labeled sample
  → NHTSA vPIC, recalls, complaints; fueleconomy.gov; Census
  → deterministic tools (comparables, mileage, history, verdict, flip margin)
  → SERV explanation with serv_shadow_agent, then a local number audit
  → Proof of AI
```

The model is not allowed to choose the verdict or invent a figure. If a field is missing, the report says it is missing.

### Deterministic rules

Constants live in `src/domain/assumptions.ts` and are copied onto each report.

- Comparables: same make and model, with price and mileage, within 1 model year. Same trim is used only when at least 3 exist. Otherwise the year window is used, then widened to 2 years. Fewer than 3 is `insufficient_data`.
- Mileage: each comparable’s asking price is shifted by `0.5%` of the median comparable price per 1,000 miles of difference from the subject.
- History: 4% off per reported accident (cap 12%), 6% off for fleet/rental/commercial, 3% off at 3+ owners, 1.5% up for one owner. Certified pre-owned adds 2% only in personal mode. Lease is not a penalty. Missing history is stated, not treated as clean.
- Personal verdict, from asking versus that fair value: under −8% good deal, through +6% fair, through +15% overpriced, above that walk away. Two or more accidents and a price that is already high moves the verdict one step worse. A NHTSA park-it or park-outside campaign is always walk away.
- Flip: resale low/high are the 25th and 75th percentiles of mileage-adjusted asking prices. Conservative proceeds use the low end after 3% sell friction. Costs add a $350 title/fee assumption and reconditioning ($600, plus $400 per reported accident, plus $200 at 100,000 miles). Margin at or above $1,500 is a good deal, at or above $500 is fair, at or above $0 is overpriced, below $0 is walk away. Time-to-sell risk is only how many comps were found, because days on market are not in the feed.

### SERV pipeline

1. **Local screen** drops empty input, very long input, and obvious instruction-override phrases.
2. **`serv_prompt_guard`** on a non-streaming gate call. The model may answer only `ALLOW` or anything else, which is treated as `BLOCK`. Prompt version `autoflip.guard.v1`.
3. **Tools** compute the report.
4. **Explanation call** (`autoflip.explain.v1`, default model `gpt-5.4-mini`, `stream: false`) includes `serv_prompt_guard` and `serv_shadow_agent`. The shadow hint requires every dollar, percentage, mileage, and VIN to appear in the facts. `max_iterations` is 2.
5. **Local number audit** parses `$` amounts, `%` values, mileages, and VINs from the prose. An unknown value, or a shadow outcome of `exhausted` or `failed`, drops the prose and shows the template. If SERV does not return an outcome in the API body or headers, the proof says `not_exposed_by_api` and the local audit still decides.

The OpenServ console’s Shadow Agent report is the provider-side record. AutoFlip’s Proof of AI block is the record stored with the report.

### Agent API

`GET /api/mcp` describes the server. `POST /api/mcp` is stateless JSON-RPC (`initialize`, `ping`, `tools/list`, `tools/call`).

- `deal_radar` — free. Same engine as the site.
- `full_report` — paid. Without a payment payload the tool returns `payment_required` (or `payments_not_configured`) and `next_action`. Ask a person before a Kite Passport session pays. Retry with `payment` set to the payload, or send `PAYMENT-SIGNATURE` / `X-PAYMENT` on `POST /api/v1/report`.

Settlement is `POST {facilitator}/verify` then `POST {facilitator}/settle` with `{ x402Version: 1, paymentPayload, paymentRequirements }`. A failed verify does not settle.

The agent payload includes the verdict, the math, comps needed to read the math, recalls, and the proof. It omits photos and Carfax links.

### Data sources

| Source | Use | Cost |
| --- | --- | --- |
| Auto.dev `GET /listings` and `GET /listings/{vin}` | Dealer listings | Free plan, hard stop at 900 calls/month in this app |
| NHTSA vPIC | VIN decode | Free |
| NHTSA recalls and complaints | Campaigns and a complaint count | Free |
| fueleconomy.gov | MPG and EPA annual fuel cost | Free |
| US Census geocoder | ZIP to coordinates, then distance | Free |
| `fixtures/autodev-camry.json` | Five real response rows, used only as a labeled sample and in tests. The account block from the original capture is not in the repo. | — |

Auto.dev terms limit the free plan to evaluation and restrict resale of the feed. This app sells a verdict, not a raw dump, and it still needs written permission before a public paid launch.

## Design

The interface follows the previous product’s frontend: warm paper canvas, Inter Tight for headings and controls, Source Serif 4 for body text, 4px controls, and the same light/dark variables. The AutoFlip mark is `public/logo.svg` (yellow tile, ink arrows). Consumer pages do not reuse that product’s name or copy.

## Deploy

The app is Next.js and deploys on Vercel as-is (`npm run build`). Do not put secrets in the repo. Set the env vars in the Vercel project. On Vercel the file store lives in `/tmp` unless `AUTOFLIP_DATA_DIR` is set, so credits and reports reset when the instance does. A durable store is a launch decision, not something this preview invents.
