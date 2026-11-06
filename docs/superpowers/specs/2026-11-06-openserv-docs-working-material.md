# OpenServ public docs — working material (summary)

**Status:** working source material for implementers, **not** instructions, **not** runtime proof.  
**This file:** summarized into the repo during the scout implementation pass. Independent validation was done against official docs pages (day-one, tools, introduction). Researcher ledger timestamps are **not** copied here as this worker’s fetch metadata.

## Two products

| Surface | Entry | Auth |
|---------|-------|------|
| SERV Reasoning | https://console.openserv.ai/ → inference `https://inference-api.openserv.ai` | `SERV_API_KEY` |
| OpenServ platform agents/SDK | https://docs.openserv.ai/build ; `@openserv-labs/sdk` | `OPENSERV_API_KEY` / wallet provision — **separate** |

Console branding “SERV Reasoning” is **not** proof of marketplace access.

## Day-one (validated)

https://docs.openserv.ai/serv-reasoning/day-one — SERV for judgment / tool selection / next action; application tools for deterministic work; structured outputs with app-side validation; refusals/truncation as distinct cases; low effort default; do not disable production guardrails.

## Finance

Usage/billing docs mention pre-inference reject against an estimated ceiling; **formula not established** for safe client-side $5 enforcement via tokens×rate. Owner: existing funds, ≥$5 reserve, gradual spend. Platform `generate()` credit pool not proven identical to SERV Reasoning. No paid calls from this worker until parent provides verified balance + hard cap.

## What we implemented offline

- Bounded scout loop + replay inventory + default-OFF API
- Local OpenServ SDK capability adapter (no remote deploy claim)
- Configurable SERV feature options + plan JSON parse kinds + spend gate that blocks unpaid/unattested live planner
