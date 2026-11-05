# AutoFlip

Evaluation preview of a US used-car verdict. The home page starts from what the shopper needs, suggests a few editorial search directions, and spends a credit only on a full analysis of one car. AutoFlip says **good deal**, **fair**, **overpriced**, or **walk away**, and shows the arithmetic.

Monitoring a saved search does not use report credits. A full analysis costs 1 credit. Anyone can open the labeled sample report at `/report/sample`. The shared preview (`/demo?key=`) still refills a small daily credit balance. Credits are sold with **Stripe test mode** only. Agents run the same full analysis by spending 1 credit with an API key. The [For agents page](src/app/developers/page.tsx) has the key buttons and the MCP snippets.

This build is an evaluation preview. The Auto.dev free plan is not a production license. The homepage photo is a licensed stock image, not a car for sale. See [CREDITS.md](CREDITS.md).

## What works

- The home flow is: a note and a budget, at most two follow-up questions, a confirmation the shopper can edit, then up to three listing searches (one Auto.dev call per direction). [Watch this search] saves a Deal Radar search. [Full analysis — 1 credit] runs on one car. A VIN asks for asking price, mileage, and ZIP. A listing link does not.
- Search directions come from a deterministic table in `src/domain/directions.ts`, labeled as AutoFlip guidance, not market data. `POST /api/need` may extract a structured need when `SERV_API_KEY` is set (`serv_prompt_guard`, then a JSON extract). If that call is missing or unusable, the form uses only the shopper's words. It does not invent a budget or a use case.
- Deal Radar scores each listing against the other listings in the same result (price, mileage, and history flags that are actually present).
- A full report adds NHTSA VIN decode, NHTSA recalls, NHTSA complaint count, fueleconomy.gov, and a Census distance when both ZIPs geocode.
- Personal mode compares the asking price with a mileage-adjusted, history-adjusted fair value.
- Flip mode estimates a resale range from comparable **asking** prices (not closed sales), then subtracts fee and reconditioning assumptions.
- Every dollar, percentage, mileage, and VIN in the written summary is checked against the tool output. A mismatch is replaced by a deterministic template.
- When `SERV_API_KEY` is set, user text is sent through `serv_prompt_guard`, and the explanation is sent through `serv_prompt_guard` plus `serv_shadow_agent`. The Proof of AI block records the steps, an inputs hash, the tool outputs, and the model.

## How we use SERV

Checked against the SERV Reasoning docs (why, day one, tools, prompt guard, content filter, shadow agent, structured outputs, reasoning effort, streaming, prompt caching, application tools, Kronos, multipath, chat completions, responses, usage and billing). Shadow settings are schema `default`s, not call-time arguments. Shadow agent is non-streaming. Multipath and Kronos are model-id suffixes, and they are not combined on one call: Kronos sits on a prose step whose numbers are checked, and the strict JSON step that follows does not use Kronos. The chat-completions schema does not document a proof object. We copy `id`, `object`, `model`, `finish_reason`, `usage`, and, on the Responses API, `output` and `output_text`, only when the body actually contains them. A header is recorded as a shadow outcome only when its name contains `shadow`. The word `exhausted` is recorded when it appears in the body. Otherwise the log says `not_exposed`.

Profiles live in `src/server/serv/profiles.ts`. Every model call uses `runServ(profileId)`. A new service is one new profile. No other file posts to the inference API.

The bounded reasoning graph is the engine under every call. This app does not configure Graph. `serv_disable_content_filter` and `serv_prompt_guard_legacy` are documented and not sent: the filter stays on, and the legacy guard is rejected if it is declared beside the current one. The Messages API is for an Anthropic-shaped client. This app uses Chat Completions and, for the rules step, Responses.

| Feature | Where | Why |
| --- | --- | --- |
| `serv_prompt_guard` | every profile | User and agent text is untrusted. The instructions are protected. |
| Content filter, left on | every profile | Default leak check on Chat Completions and Responses. Nothing here should quote hidden instructions. |
| `serv_shadow_agent` | `report_explain` and `agent_explain` (facts hint, 2 iterations), `personal_alert_review` (one-sentence hint, 1), `flip_judge` (estimate hint, 2) | A second pass on wording that can change what a person sees. The personal review uses one pass so it stays near a few seconds. `flip_feasibility` does not use it: Kronos plus a shadow pass ran past its timeout. |
| `-serv-multipath` | `flip_judge` | Alert versus skip is a branching policy. |
| `-serv-kronos` | `check_rules`, `flip_feasibility` | Procedural VIN/listing rules and flip feasibility rules. Output is prose. A number that is not in the facts is dropped, and the deterministic result remains. |
| Strict `json_schema` | `need_extract`, `flip_judge` | Software consumes the need and the alert-or-skip verdict. |
| `reasoning_effort` | `none` on `report_explain` and `agent_explain` (a function tool on chat completions). `low` on gates, extraction, and Telegram. `medium` on the rules, flip, and personal-alert steps | Chat completions reject `read_computed_facts` unless effort is `none`. The responses tool round-trip is not used for that tool. |
| Prompt cache, left on | every profile | System text is stable. Changing data stays in the user message. The cache opt-out is for tests, not this preview. |
| Streaming | `telegram_reply` | The reply is prose and has no second pass. Shadow agent rejects a stream. |
| Responses reasoning summary | `check_rules` | That step needs the reasoning trace (`output` when the body includes it) beside the rules prose. |
| Application tool `read_computed_facts` | `report_explain`, `agent_explain` | The writer must read figures the site already calculated. It does not calculate them. |
| Usage logging | every call | `usage`, `finish_reason`, latency, and the fields above are stored on the proof. |

| Profile | Model suffix | Tools | Why |
| --- | --- | --- | --- |
| `need_guard`, `need_extract` | none | guard; extract also has strict `json_schema` | `/find`. The app consumes the JSON. |
| `check_guard` | none | prompt guard | `/check` listing or VIN before the report runs. |
| `check_rules` | `-serv-kronos` on the Responses API | prompt guard, reasoning summary | VIN and listing rules. Prose is dropped when it adds a number. |
| `report_guard`, `report_explain` | none | guard; explain also has shadow agent and `read_computed_facts` | Personal and Flip full reports. |
| `agent_guard`, `agent_explain` | none | same pair as the report, with the agent hint | `/api/mcp` `full_report` and `POST /api/v1/report`. |
| `radar_guard` | none | prompt guard | Saved-search text and one-off scans. |
| `personal_alert_review` | none | prompt guard plus shadow agent | Personal radar sentence. Code owns the numbers. |
| `flip_feasibility` | `-serv-kronos` | prompt guard | Flip rules before the verdict. No shadow pass, so the step stays inside its timeout. |
| `flip_judge` | `-serv-multipath` | prompt guard, shadow, strict `json_schema` | Flip top 5. Code already computed profit, comps, and speed. |
| `telegram_reply` | none | prompt guard, streamed | `/help` and a bare `/start`. If the call fails, the published connect text is sent. |

Paid agent responses (`deal_radar`, `full_report`, `POST /api/v1/report`) always include `proof`. It copies the inference fields that were actually present and adds `profiles` (tools, suffixes, guard result, shadow outcome and iteration cap, latency) plus `codeComputed`. The shopper-facing "Why we decided this" note is rendered from those recorded flags. It is not another model call.

## Compare standard and checked answers

`npm run eval:serv` is an offline script. It exits immediately when `SERV_API_KEY` is missing. It runs the fixed cases in `src/domain/eval-cases.ts` twice per assigned profile: the same base model with no SERV tools and no suffix, then the profile. Prices and VINs come from `fixtures/autodev-camry.json`. Adversarial seller notes are marked synthetic. Scores are injection followed, invented number, schema valid, and verdict consistent with the facts. Output is `eval/results/latest.json` and `latest.md`. Commit those after a real run. `/compare` reads the JSON and will not invent a trap.

The published GPT-5.4 Mini rates, which include SERV Reasoning, are $1 per million input tokens and $6 per million output tokens. The script prints an estimate before it starts: 44 pairs, one plain call each, and about three model calls on the checked side (shadow, Kronos, or the figure-reading follow-up). At 900 input and 180 output tokens per call, that is roughly $0.35 to $2 at the published mini rates. Treat that as an estimate, not a credit balance. The JSON records the token totals the API actually returned.

`GET /api/serv/selftest` with `Authorization: Bearer $RADAR_CRON_SECRET` runs one short call per distinct profile shape in parallel. Each call uses that profile's own timeout. The response includes latency and that timeout. A guard-only call in production took about 3 seconds. A personal alert review took about 12 seconds, so that timeout is 25 seconds. The flip rules check is a short low-effort prompt so it finishes under its 20 second limit. The report explanation puts the calculated facts in the request and still asks the model to call the figures tool. Two explanation requests still fit under the 60 second Hobby limit because the shapes run together. If a written check does not finish, the calculated verdict is what the shopper sees, with a line that the written check did not finish.

If a SERV call fails or times out, the deterministic result still shows and the log says explanation unavailable. The model cannot change the numbers. `/compare` shows a labeled sample beside that unavailable state. It is not a fabricated model paragraph.
- Auto.dev calls stop at 900 per UTC month and are cached for 6 hours. A stopped month returns a plain “demo limit reached” message and does not call the provider.
- Without `AUTODEV_API_KEY`, Deal Radar and reports for the five fixture VINs use the labeled sample. Other VINs are refused. The sample is never mixed into a live result.
- Stripe Checkout in test mode, with live keys refused. The webhook grants credits once per event.
- MCP (`deal_radar`, `full_report`) and `POST /api/v1/report`. A signed-in browser creates an API key on `/developers`. The raw key is shown once and stored as a SHA-256 hash. `Authorization: Bearer af_…` spends 1 credit from that account for `full_report`. `deal_radar` stays free. A zero balance returns `insufficient_credits` and a buy-credits link, and does not run the analysis. The same JSON-RPC id or `Idempotency-Key` does not spend twice. Responses still include `proof`. A payment header remains optional when that rail is configured.

## What is stubbed, and why

- **MarketCheck** is a disabled adapter (`src/io/marketcheck.ts`). It is not called. The free tier is evaluation-only, and its cache terms do not fit Deal Radar. Leave it off until a written production license exists.
- **Listing URLs are not scraped.** A URL is accepted only when it contains a valid VIN. The VIN is then looked up at Auto.dev.
- **No days-on-market and no NMVTIS title brands.** They are not in the listing fields this app uses, and no second paid history vendor is connected. The report says so.
- **Fuel cost** is the EPA figure from fueleconomy.gov when a configuration matches. AutoFlip does not invent a gas price.
- **SERV** is skipped, and the template is used, when `SERV_API_KEY` is unset. If the key is set and the guard call fails on a report or a listings scan, the request stops. On `POST /api/need`, a failed or missing model call falls back to the form instead of inventing a need.
- **Editorial directions** are not prices and not a ranking. A budget that was skipped is not treated as an affordability check. Flip repair ability is stored as repair ability only.
- **Credits, quota, cache, and saved reports** are JSON files (`.data/` locally, `/tmp/autoflip` on Vercel). They are ephemeral on serverless and are not safe for a public launch. Point `AUTOFLIP_DATA_DIR` at durable storage, or replace `src/io/store.ts`, before real customers.
- **Agent payment** is implemented as verify-then-settle against `X402_FACILITATOR_URL`. Nothing is paid from this app. Set `X402_PAY_TO`, `X402_NETWORK`, and `X402_ASSET` when you want agents to pay. The default scheme is `gokite-aa`. Set `X402_SCHEME` when the facilitator expects a different one.
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
- `full_report` — paid. Without a payment payload the tool returns `payment_required` (or `payments_not_configured`) and `next_action`. Ask a person before a session pays. Retry with `payment` set to the payload, or send `PAYMENT-SIGNATURE` / `X-PAYMENT` on `POST /api/v1/report`.

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

## Deal Radar watcher

A saved search is checked on a schedule. Monitoring does not spend a credit. A full report still costs 1 credit, and only after an explicit Analyze click. A VIN is marked seen only after it passes the pre-filter for that search and rule version. Rows that were filtered out are judged again on the next run, and a criteria or rule change uses a new seen key.

The shared preview is `/demo?key=$DEMO_ACCESS_KEY`. It signs every visitor in as one client, refills `DEMO_CREDITS` once per UTC day, and turns on both radar modes without a charge. Presets: a 2012–2020 Toyota RAV4 up to $24,000 within 100 miles of Miami (33101), and a budget-only Flip scan at $12,000 within 50 miles of 33101 (no model, no mileage, no profit target). Visitors can add at most one extra shared search. Check now is limited to once per 30 minutes globally. A preset’s criteria update the next time the preview or the cron runs.

Personal watches can list several models and alert on a new match or a price drop of at least $300 and 3%. Flip scans use at most two cached pages per cycle, then rank up to five cars. Profit and speed of sale are estimates from that scan. Fewer than three comps is excluded. Listing age is used only when the feed includes it; otherwise speed is unknown. Preview plan prices are on `/pricing`. Report credits stay separate.

### Auto.dev, checked 4 Nov 2026

One radar check is one `GET /listings` with `limit=20`. The listings product page says the Free plan clamps `limit` to 20 (Growth 100, Scale 500). The reference page still says the default is 100 and that the per-plan cap “will be enforced in a future release.” Requesting 20 stays inside both descriptions. Free plan is 1,000 calls/month and 5 requests/second.

The make menu is a fixed list of mainstream US used-car makes (including Pontiac, Saturn, Mercury, Scion, Hummer, and Saab). vPIC’s make list is not used, because it also returns kit builders and bus makers. Models for the chosen make come from NHTSA vPIC (`GetModelsForMake` or `GetModelsForMakeYear`), cached for a day, with chassis, trailer, and bus names removed. Those calls never use the listings quota. Spellings sent to Auto.dev are the ones it expects (`Toyota`, `Mercedes-Benz`, `RAV4`, `CR-V`, `F-150`). Any model leaves `vehicle.model` off the request. Year menus stop at the current calendar year plus one.

Server-side filters used here: `vehicle.make`, `vehicle.model`, `vehicle.bodyStyle` when a search sets one, `vehicle.year` (`2012-2020` on the RAV4 preset), `retailListing.price`, `retailListing.miles`, `retailListing.used`, `zip`, `distance`, and `sort=price.asc`. The default sort is `updatedAt.desc`, which returns the most recently touched listings rather than the cheap end of the market. Comma means OR and a dash is an inclusive range. Priorities such as “family” or “minor repairs” are not API filters. They stay on the saved search and are not sent.

This environment had no `AUTODEV_API_KEY`, so the presets were not executed against live inventory. The first scheduled run records the real count. An empty result is logged and is not filled with sample cars.

### Call budget

The existing hard stop remains 900 calls/month for every listings request. Radar checks stop at 650. The gap is left for full reports and one-time scans. Identical criteria across people share one call. The gap between checks stretches from 3 hours toward 24 so that `unique searches × checks per day × 30` stays near 650. GitHub Actions (`.github/workflows/radar-cron.yml`) calls `POST /api/radar/cron` every 3 hours. Vercel Hobby crons are daily, so they are not used. Repository secrets: `RADAR_CRON_URL`, `RADAR_CRON_SECRET`.

### Storage

Upstash Redis free tier, REST API, no extra npm package. Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` on Vercel. That holds saved searches, seen VINs, alerts, the run log, credits, reports, and both monthly counters. On Vercel without those variables the cron refuses to run and says storage is not configured. On a laptop the same data goes to `.data/kv.json`.

### Each run

1. `serv_prompt_guard` on the saved criteria when `SERV_API_KEY` is set. Otherwise the log says `not_configured`.
2. The listings call (`sort=price.asc`), then a local pre-filter. The market band is built only from rows that already match make, model, budget, year, miles, body, and radius. Personal mode flags a price at or under the 25th percentile, a price at or under 92% of the median, or low miles. Flip mode still requires a $1,500 rough margin after the fee and reconditioning assumptions, measured against the 75th percentile of that page, because the median of ~20 similar cars sits too close to every asking price to clear those costs. The run log records a count per reject reason. A price under $800 or under 40% of the median is rejected as suspicious.
3. `serv_shadow_agent` reviews each alert sentence. A sentence that adds a number is replaced by the deterministic sentence. The log records the outcome.
4. An agent payment to `POST /api/v1/radar-ticket` only when the payment variables are set and the network is the test network the route accepts. Missing variables are listed in the run and no transaction is invented. The amount shown is `X402_PRICE_ATOMIC`. Remaining session budget is recorded only if the execute response includes it.
5. Telegram, when `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, and `TELEGRAM_WEBHOOK_SECRET` are set. Connect from Deal Radar. The webhook is `POST /api/telegram/webhook` and checks `X-Telegram-Bot-Api-Secret-Token`. Set that secret with `setWebhook`. Without the bot, alerts stay in the app and the log says Telegram is not configured.

The activity log (`/activity`, shared preview only) shows runs, counts, SERV results, and the testnet payment status. Those words stay off the home page, the alert feed, and the report.

## Design

The interface follows the previous product’s frontend: warm paper canvas, Inter Tight for headings and controls, Source Serif 4 for body text, 4px controls, and the same light/dark variables. The AutoFlip mark is `public/logo.svg` (yellow tile, ink arrows). Consumer pages do not reuse that product’s name or copy.

## Deploy

The app is Next.js and deploys on Vercel as-is (`npm run build`). Do not put secrets in the repo. Set the env vars in the Vercel project. On Vercel the file store lives in `/tmp` unless `AUTOFLIP_DATA_DIR` is set, so credits and reports reset when the instance does. A durable store is a launch decision, not something this preview invents.
