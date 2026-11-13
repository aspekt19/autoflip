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

The main user flow is behind verified sign-in. Find and Resale reserve one report credit before the agent runs and charge only when a result is delivered. Check includes three free VIN-scoped checks per verified account per UTC month, then uses one report credit.

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

The boundary is deliberate:

- **SERV** interprets the request, chooses which tools to use, evaluates candidates, and explains its decision.
- **Code** owns listing identifiers, source provenance, distance calculations, comparable-price math, offer fields, resale profit, billing, and safety checks.
- **Guardrails** reject unsupported VINs, budget or known-radius violations, reported accidents or title brands when the brief forbids them, malformed offers, and non-positive Resale buy/negotiate decisions.
- **Unknown is not clean.** Missing history, unavailable pages, and unverified distance are labeled as unknown rather than silently treated as passed checks.
- **Nothing-fits is a valid result.** The system does not have to manufacture a winner to finish a search.

Every delivered run can carry a decision journal showing which steps were performed by SERV, which were computed by code, and where a safety rule constrained the result.

## Evidence: a real Denver search

The public [Proof page](https://autoflip-umber.vercel.app/proof) contains the recorded answers, run links, source links, and a criterion-by-criterion comparison for this request:

> I'm in Denver 80202, budget $22k all-in, need an AWD SUV for mountain winters and a 40-mile daily commute. Two kids, so safety matters most. Under 90k miles, no accident or salvage history, low fuel cost. Within 75 miles. Which one should I buy and what should I offer?

The capture shows the distinction between advice and an actual inventory result:

- A plain chat answer named a vehicle to shop for, but had no live listing or VIN.
- The captured Perplexity answer also declined to claim it had found a qualifying live listing.
- Both Lemonless runs returned real VINs from live inventory. The features-on run also returned a dealer listing URL that was reachable when checked.

**Important evaluation limits:** the two Lemonless runs each performed their own live search. They did not receive the same frozen candidate set, so the different picks do not prove that turning SERV features on caused a better decision. A same-snapshot comparison is a separate experiment and is not claimed as a completed result here.

The capture was recorded at **2026-11-13 14:29:45 UTC**, before the later no-accident and radius hardening merged in [PR #207](https://github.com/aspekt19/autoflip/pull/207) at 16:18 UTC. The historical output includes a listing record with one reported accident; it must not be read as proof that the current hard gate passed that car. The [Proof page](https://autoflip-umber.vercel.app/proof) now carries this disclosure alongside the original evidence. The recorded responses and their source links are preserved unchanged.

## What the product does not claim

- Lemonless does **not** currently provide a complete CARFAX, AutoCheck, or NMVTIS vehicle-history report.
- A model-year recall or complaint record does not establish the open/closed recall status of an individual VIN.
- Comparable listing prices are **asking prices**, not verified completed-sale prices.
- Estimated fair value, offers, and resale margins are decision support, not guaranteed market outcomes.
- A listing page can disappear or be blocked. Confirm the seller, availability, title, fees, and history yourself, and get an independent inspection before buying.

## Agent access

Create an API key from [Developers](https://autoflip-umber.vercel.app/developers). Send **Authorization: Bearer af_…** on **every** REST or MCP request.

- MCP: **POST /api/mcp**
- REST: **/api/v1/check**, **/api/v1/find**, **/api/v1/resale**, **/api/v1/radar/watches**, **/api/v1/radar/check**, **/api/v1/radar/feed**, and **/api/v1/report**
- API reference: [OpenAPI](https://autoflip-umber.vercel.app/openapi.json) · [LLM instructions](https://autoflip-umber.vercel.app/llms.txt)
- Transparency: [Where SERV runs](https://autoflip-umber.vercel.app/where-serv-runs) · [Proof](https://autoflip-umber.vercel.app/proof) · [Verify](https://autoflip-umber.vercel.app/verify)

The same decision logic is exposed through the site, REST, and MCP. Agent reports use the same evidence and decision journal as the browser product.

## Run locally

Requires Node.js 22.

~~~bash
npm ci
cp .env.example .env.local
npm run dev
~~~

For a local report without Stripe, set **AUTOFLIP_DEV_CREDITS=3** in **.env.local** and restart.

Run the same core checks used by CI:

~~~bash
npm run typecheck
npm test
npm run golden
npm run test:e2e
npm run build
~~~

Model and provider-backed evaluation commands can make paid requests. Review the script's explicit opt-in gates before running them.

### Environment

| Variable | Purpose |
| --- | --- |
| **AUTODEV_API_KEY** | Live listing search |
| **SERV_API_KEY** | SERV inference |
| **SERV_MODEL** | Optional default model id for SERV steps |
| **SERV_BASE_URL** | Optional inference endpoint; defaults to OpenServ |
| **UPSTASH_REDIS_REST_URL** / **UPSTASH_REDIS_REST_TOKEN** | Durable production storage |
| **AUTH_SECRET** | Auth.js session signing |
| **AUTH_GOOGLE_ID** / **AUTH_GOOGLE_SECRET** | Google sign-in |
| **NEXT_PUBLIC_FIREBASE_API_KEY**, **NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN**, **NEXT_PUBLIC_FIREBASE_PROJECT_ID**, **NEXT_PUBLIC_FIREBASE_APP_ID** | Firebase email-link sign-in; all four are required to show the option |
| **STRIPE_SECRET_KEY** / **STRIPE_WEBHOOK_SECRET** | Stripe checkout and webhook; currently **test mode only** |
| **NEXT_PUBLIC_APP_URL** | Checkout and auth callback origin |
| **AUTOFLIP_DEV_CREDITS** | Optional local starting credit balance |
| **TELEGRAM_BOT_TOKEN** / **TELEGRAM_BOT_USERNAME** / **TELEGRAM_WEBHOOK_SECRET** | Optional Deal Radar Telegram copy |

Do not commit **.env.local**.

## Release notes

- Stripe remains in **test mode**. The test card is **4242 4242 4242 4242**; purchases are not real revenue.
- Legacy repository, Vercel, cookie, and AUTOFLIP-prefixed environment names remain for compatibility. The product name is **Lemonless**.
- The daily Deal Radar cron is configured in **vercel.json**.
