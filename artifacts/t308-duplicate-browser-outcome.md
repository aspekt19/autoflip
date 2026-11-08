# t308 — Duplicate Live Find browser outcome (correction)

**Source run:** computerUse [Live Find full-analysis browser](bc-f607789b-06d9-5fd7-af2b-fe777e126fc8)  
**Target:** production `https://autoflip-umber.vercel.app/` (main `06f8bad`)  
**Scope of this note:** read-only correction. No code, no env changes, no purchases, no live API spends.

---

## What happened

| Step | Result |
| --- | --- |
| Find | Worked (ordinary flow reached listing results) |
| Full analysis | Blocked at **0 credits** → redirect `/credits?need=1` |
| Debit | **None** (balance stayed 0) |
| Report | **None** delivered |

This matches product gates: no credit → no spend → no report.

---

## Correction: do **not** set `AUTOFLIP_DEV_CREDITS` on production

The earlier browser write-up (`artifacts/t308-browser-find-fullanalysis.md`) recommended configuring production `AUTOFLIP_DEV_CREDITS=3`. **That recommendation is wrong for shared/prod deploys.**

| Source | Intent |
| --- | --- |
| `.env.example` | *"Optional one-time starting balance for local evaluation. **Unset in any shared deploy.**"* |
| `README.md` | *"For a **local** full report without Stripe"* / table: *"Optional **local** starting balance"* |
| `artifacts/t308-test-credit-path.md` | Path C — **dev seed only**; not consumer UI |

**Would enabling it on prod violate product intent / security?** **Yes.**

- Env is not gated by `NODE_ENV`; if set on Vercel production it seeds **every new** `af_uid` via `ensureAccount` (`src/server/session.ts`).
- That free-credits every anonymous visitor, bypasses Stripe test/live monetization intent, and contradicts explicit “unset in any shared deploy.”
- **Do not set on production without explicit owner decision.** This agent does not change env.

---

## Flip-safe path (restated)

Per `artifacts/t308-test-credit-path.md`:

1. **Preferred:** reuse an existing normal-browser session with `af_uid` + nonzero Header balance (no Incognito).
2. **Else:** Credits UI **Path A** — Stripe **test-mode** “Buy in test mode” + test card `4242…` (requires `sk_test_` + webhook). No real money when gates hold.
3. **Avoid:** Path B demo unless shared ledger is acceptable; fresh Incognito (defaults to 0).
4. **Reject for Flip QA:** enabling `AUTOFLIP_DEV_CREDITS` on production without owner.

**Further live Find → Full analysis journey:** owned by **parent Flip** once credits exist via (1) or (2). Duplicate browser ended with **0 debit / no report** — **no further action** from this scoped agent.

---

## PR note

ManagePullRequest unavailable in this run — skip updating PR #75 body. Parent may note: duplicate browser ended with 0 debit, no report, no further action; do not enable prod `AUTOFLIP_DEV_CREDITS` without owner.
