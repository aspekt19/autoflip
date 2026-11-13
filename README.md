# Lemonless

**A tool-using AI agent for buying and evaluating used cars in the United States.** Start with a short buyer brief. Lemonless searches live listings, checks available vehicle data, and returns an evidence-backed next step — including when nothing fits.

[**Open the app**](https://autoflip-umber.vercel.app/) · [**See the live comparison**](https://autoflip-umber.vercel.app/proof) · [Architecture](docs/ARCHITECTURE.md) · [Agent API](https://autoflip-umber.vercel.app/developers)

[![CI](https://github.com/aspekt19/autoflip/actions/workflows/ci.yml/badge.svg)](https://github.com/aspekt19/autoflip/actions/workflows/ci.yml)

Built for **OpenServ SERV Hackathon Edition 02 — Open Track**.

## Try the product

- **Find** — describe the car you need in ordinary language, confirm the brief, and let the agent search current inventory. It can return a shortlist or explicitly say that no car meets the request.
- **Check** — submit a VIN, listing URL, or pasted listing. Lemonless calculates price context in code and gathers available VIN, safety, recall, complaint, fuel-economy, and market evidence before producing a review.
- **Resale** — search within a budget and evaluate candidate flips using code-calculated costs and risk-adjusted profit. The agent cannot turn a negative-profit candidate into a buy.
- **Deal Radar** — save watches and receive in-app alerts when matching inventory changes. Optional Telegram delivery sends a copy of the alert.

The main human user flow is behind verified sign-in. Find and Resale reserve one report credit before the agent runs and commit only when a qualifying result is delivered. Check includes three free VIN-scoped checks per verified account per UTC month, then uses one report credit.

## External AI-agent access and payments

External agents can discover Lemonless through [agent.json](https://autoflip-umber.vercel.app/.well-known/agent.json), [OpenAPI](https://autoflip-umber.vercel.app/openapi.json), [llms.txt](https://autoflip-umber.vercel.app/llms.txt), or the free MCP tool `get_payment_info`.

Lemonless supports **x402 v2 exact payments in USDC on Base Mainnet**. The public treasury address is:

`0x250aC40Ab38E4f023c33C1c3DFD0Cd07357Fbf79`

| Agent action | Endpoint | Price |
|---|---|---:|
| Register an autonomous agent and receive an `af_` key | `POST /api/agents/register` | $0.01 USDC |
| Run one direct vehicle report | `POST /api/v1/report` | $3.00 USDC |
| Buy 3 report credits | `POST /api/agents/billing/credits`, `pack_3` | $9 USDC |
| Buy 10 report credits | Same, `pack_10` | $25 USDC |
| Radar — 1 saved watch / up to 300 reviews | `POST /api/agents/billing/plans`, `radar` | $100 USDC / 30 days |
| Radar Pro — 3 saved watches / up to 900 reviews | Same, `radar_pro` | $250 USDC / 30 days |

The protocol uses network `eip155:8453`, USDC contract `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, and the `exact` scheme. Agents send the signed payload in `PAYMENT-SIGNATURE`; successful settlement returns `PAYMENT-RESPONSE`. The initial 402 response advertises the required amount and machine-readable Bazaar input/output schema.

Registration binds a new `af_` key to the payer wallet. The key is returned once and must be stored securely by the agent. After registration, the agent can use the existing REST/MCP API; credit top-ups and plan purchases require that key. Find and Resale continue to use credits so that payment is committed only when a qualifying result is delivered. Radar x402 plans are prepaid 30-day access, renew manually, and do not auto-charge.

**Operational requirement:** x402 is enabled only when `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` for the Coinbase CDP facilitator are configured in the deployment environment. The app reports current readiness from `GET /api/agents/payment-info`. No wallet private key for the receiver is stored in the application. Human browser billing remains Stripe **test mode only**.

## What makes Lemonless different

SERV reasons over the buyer's brief and the evidence returned by tools. **TypeScript owns the facts, arithmetic, and hard limits.** The model does not calculate a fair price, invent a VIN, or create a profit figure.

~~~mermaid
flowchart TD
  A[Buyer brief] --> B[Confirm the brief]
  B --> C[SERV agent loop]
  C --> D[Live listings and vehicle-data tools]
  D --> E[SERV selects a candidate or says none fit]
  E --> F[Code validates VIN and hard constraints]
  F --> G[Code computes distance, offers, and money]
  G --> H[Decision journal and report]
~~~

- **SERV** interprets the request, chooses which tools to use, evaluates candidates, and explains its decision.
- **Code** owns listing identifiers, source provenance, distance calculations, comparable-price math, offer fields, resale profit, billing, and safety checks.
- **Guardrails** reject unsupported VINs, budget or known-radius violations, reported accidents or title brands when the brief forbids them, malformed offers, and non-positive Resale buy/negotiate decisions.
- **Unknown is not clean.** Missing history, unavailable pages, and unverified distance are labeled as unknown rather than silently treated as passed checks.
- **Nothing-fits is a valid result.** The system does not have to manufacture a winner to finish a search.

Every delivered run can carry a decision journal showing which steps were performed by SERV, which were computed by code, and where a safety rule constrained the result.

## Evidence: a live Denver search

The public [Proof page](https://autoflip-umber.vercel.app/proof) now shows one recorded case comparing Gemini Chat in **Auto** mode with Lemonless Find on the same buyer request:

> I'm in Denver 80202, budget $25k all-in, need an AWD SUV for mountain winters and a 40-mile daily commute. Two kids, so safety matters most. Under 100k miles, no accident or salvage history, low fuel cost. Within 75 miles. Which one should I buy and what should I offer?

Gemini returned general model-level advice, recommending 2022–2023 Subaru Forester and 2023 Mazda CX-5 families, with an opening negotiation target of $24,200 out the door.

Lemonless Find searched live inventory and selected a specific **2021 Subaru Forester Premium AWD** in Longmont, Colorado: VIN `JF2SKAJC5MH423912`, listed at $20,197 with 89,215 miles. Its structured offer was $19,000 to open, with a $20,000 vehicle-price walk-away point and a $25,000 all-in ceiling. The run included VIN decode, safety, fuel-economy and local asking-price evidence checks.

The Find result was produced by the same server-side chat function used by `/api/find/chat`, in an isolated evaluation run that did not charge a customer credit or modify production data. This is one case study, not a statistically representative benchmark or a claim that Find always selects the best vehicle. The Proof page links the original Gemini conversation, the vehicle listing and the test record.

## What the product does not claim

- Lemonless does **not** currently provide a complete CARFAX, AutoCheck, or NMVTIS vehicle-history report.
- A model-year recall or complaint record does not establish the open/closed recall status of an individual VIN.
- Comparable listing prices are asking prices, not verified completed-sale prices.
- Estimated fair value, offers, and resale margins are decision support, not guaranteed market outcomes.
- Confirm the seller, availability, title, fees, and history yourself, and get an independent inspection before buying.

## Agent access

Create an API key from [Developers](https://autoflip-umber.vercel.app/developers) or use paid x402 registration at `POST /api/agents/register`. Send `Authorization: Bearer af_…` on every REST or MCP request.

- MCP: `POST /api/mcp`
- REST: `/api/v1/check`, `/api/v1/find`, `/api/v1/resale`, `/api/v1/radar/*`, and `/api/v1/report`
- Agent payments: `GET /api/agents/payment-info`, `POST /api/agents/register`, `POST /api/agents/billing/credits`, `POST /api/agents/billing/plans`
- Transparency: [Where SERV runs](https://autoflip-umber.vercel.app/where-serv-runs) · [Proof](https://autoflip-umber.vercel.app/proof) · [Verify](https://autoflip-umber.vercel.app/verify)

The same decision logic is exposed through the site, REST, and MCP. Agent reports use the same evidence and decision journal as the browser product.

## Run locally

Requires Node.js 22.

~~~bash
npm ci
cp .env.example .env.local
npm run dev
~~~

For a local report without Stripe, set `AUTOFLIP_DEV_CREDITS=3` in `.env.local` and restart.

Run the same core checks used by CI:

~~~bash
npm run typecheck
npm test
npm run golden
npm run test:e2e
npm run build
~~~

Model and provider-backed evaluations can make paid requests. Review their explicit opt-in gates before running them.

### Environment

| Variable | Purpose |
| --- | --- |
| `AUTODEV_API_KEY` | Live listing search |
| `SERV_API_KEY` | SERV inference |
| `SERV_MODEL` / `SERV_BASE_URL` | Optional model and endpoint |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Durable production storage |
| `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET` | Auth.js / Google sign-in |
| `NEXT_PUBLIC_FIREBASE_*` | Firebase email-link sign-in |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Human checkout; test keys only |
| `CDP_API_KEY_ID` / `CDP_API_KEY_SECRET` | Optional CDP facilitator auth for x402 |
| `X402_PAY_TO_ADDRESS` | Optional USDC receiver override; defaults to the published treasury |
| `X402_FACILITATOR_URL` | Optional CDP facilitator URL override |

Never commit `.env.local` or facilitator credentials.

## Release notes

- Stripe remains in **test mode**. The test card is `4242 4242 4242 4242`; purchases are not real revenue.
- External agent x402 payments use Base USDC. Credit packs and prepaid Radar terms are separate from the human Stripe flow.
- Legacy repository, Vercel, cookie, and AUTOFLIP-prefixed environment names remain for compatibility. The product name is Lemonless.
- The daily Deal Radar cron is configured in `vercel.json`.
