## Summary

**t317 CORE on PR #77** — fold parent Mini / Sonnet 5.5 / Gemini 3.1 Pro Preview SAME-input evidence into a coherent product vertical slice (not a residual list). **No hosted SERV/provider calls in this agent.** Production `BASE_MODEL` remains Mini until compatibility + independent review + parent representative cycle.

### Reviewable tip

| Pin | Value |
| --- | --- |
| PR | https://github.com/aspekt19/autoflip/pull/77 |
| Branch | `cursor/t315-clarify-owncost-ecfd-1033` |
| Base | `main` @ `0aeed3b3fc7611be47eab0eff6b737a9abf869bd` (PR76 published) |
| **Implement tip** | `e5df318a5faeb1eb462def0ac23636d40f87f920` / tree `7e80af2e66590cd2c4c0b0dac3d8eb32a2f1be09` |
| **Branch tip** | `134eba570fafd6674fb5a1ac754f4d0528a968e8` / tree `9e6291415b38eeda1bafd28997bd7918218a7e99` |
| **CI** | pending after push — parent reconciles |

### Parent evidence folded (not re-run here)

| Model | Outcome | Notes |
| --- | --- | --- |
| **Mini** | 1× HTTP200 grounded abstain ~5.675s / 3887 tokens | False terminal: “search already used once” while `providerUsed=1` / `maxProviderCalls=3` |
| **Sonnet 5.5** | 2× HTTP200 grounded D1 reject placeholder (`missing_asking_price`, not defect) + D2 abstain (no replacement) ~7.6s+14.8s / 15839 tokens | Valid path; missing revised search under remaining budget |
| **Gemini 3.1 Pro Preview** | 1× HTTP200 content null / refusal ~19 chars / finish stop ~4.5s | Schema false / parse failure / no action; usage shape present but **tokens null** telemetry gap. Refusal reason **NOT known** — do **not** assert format-failure or safety-cause RCA |

Console reconcile pending (23.38→23.37 Mini → 23.31 Sonnet). Reviewed PR71 `e7a2e2d` pack matches pin; does **not** prove production/autonomy.

### CORE product (this tip)

| Change | Detail |
| --- | --- |
| **Reversible per-profile model** | `SERV_PROFILE_MODEL_SCOUT_PLAN=claude-sonnet-5.5` (allowlisted) beats global `SERV_MODEL`; unset → Mini. Production `BASE_MODEL` unchanged. Fail-closed on unlisted unless `SERV_PROFILE_MODEL_ALLOW_UNLISTED=1` / experiment harness. |
| **Gemini diagnostics** | `content_null_refusal_field` + reasonCode + refusal **bytes only** + usage via camelCase/alias coerce; never raw refusal; strict guards not weakened; no blind Gemini rerun. |
| **searchContinuation clamp** | Live `servScoutPlanner` + offline heuristic share `clampScoutPlanWithSearchContinuation`: premature abstain / duplicate search → revised in-mandate `inventory.search` when budget remains. |
| Find vertical slice (prior) | clarifications / own-cost / shortlist / next-checks retained |

Does **not** invent prices/makes; duplicate fingerprints still rejected; credit/fail-closed/numeric guards preserved.

### Offline evidence
- `npm run typecheck` + `npm test` → **695** passed
- Scenario: PR63 placeholder ledger → clamp abstain → `inventory.search` suggestion

### Flip-only remaining (parent)
- Fresh head CI / pin check
- Independent review → publish
- Actual representative SERV cycle (parent; Flip sole spend)
- Console balance reconcile

### Not claimed
Full-cycle Scout success; model winner; invented usable inventory; format vs safety RCA for Gemini; production flipped to Sonnet.
