## Summary

**NOT RELEASE READY — do not merge.**

Ordinary Find auto-continue (accepted) **plus** Flip sequential gap closed: when SERV returns `inventory.search` that matches an allowlisted suggestion / validated revision, code **executes an immutable recorded receipt** and feeds it into Decision-2 — no dead `requires_external_tool` stop after echoing a prefilled query.

Base = main `ba6e127`. Branch `cursor/find-nextcheck-live-apply-ecfd-1033` / PR #78.

### Pins

| Pin | Value |
| --- | --- |
| Branch | `cursor/find-nextcheck-live-apply-ecfd-1033` |
| Base | `ba6e127d399afa8b64126dcf35da73fdd8f81158` |
| Tip | `5073875` _(docs pin; update after CI)_ |
| Implement | `6eedde6c695e29978b66d91f08b58d4cec10d557` / tree `522608d89e1e788be1e6cce0c0585a80d518a6ff` |
| Prior tip | `bc00abac64c0d6f561587296cbb261edb75750af` |
| CI | _(fill after green)_ |

### Accepted preserved

Token-only owned context · NEW-need rematch · SET NX claims · auto-continue until grounded/clarify/fail/unchanged · gpt-5.6-sol / fable-5 allowlist · credit/SSRF/loop guards.

### This iteration (suggestion-echo → real tool receipt → replan)

1. **`executeRecordedInventorySearch`** (`src/domain/scout/recorded-inventory-execute.ts`) — suggestion-matched / in-mandate `inventory.search` → immutable receipt (default `freshVinCount=0`; never invents cars / never resurrects non-pending VINs without explicit recorded resolver).
2. Sequential harness **defaults to recorded-execute** (`enableRecordedInventoryExecute !== false`) so D1 search → D2 with tool evidence in `recentOutcomes` + `searchHistory`.
3. **Ablation:** `SCOUT_COMPARE_HIDE_SUGGESTIONS=1` withholds ready-made suggestions (models must choose useful checks). Prefer for discriminatory Fable/Sol runs — **not** price-alone Fable spend.
4. Pack `COMMANDS.md` updated for execute + ablation; Flip shortlist unchanged (Sonnet → Sol → Fable).
5. Parent-only hosted spend. No cosmetic archive repack. No merge.

### Parent Flip retest (≤2 HTTP / model)

```bash
# Baseline with suggestions present — expect D1 search EXECUTED → D2 (not stop)
SERV_API_KEY=… SCOUT_COMPARE_ALLOW_PAID=1 SCOUT_COMPARE_SEQUENTIAL=1 \
  SERV_COMPARE_MODELS=claude-sonnet-5.5 \
  SCOUT_COMPARE_SOURCE_PIN='{"head":"<TIP>","tree":"<TREE>","pr":78,"pack":"artifacts/flip-t318-decision-pack"}' \
  npm run eval:scout-model-compare

# Ablation (no prefilled suggestions) — discriminatory multistep
SERV_API_KEY=… SCOUT_COMPARE_ALLOW_PAID=1 SCOUT_COMPARE_SEQUENTIAL=1 \
  SCOUT_COMPARE_HIDE_SUGGESTIONS=1 \
  SERV_COMPARE_MODELS=claude-sonnet-5.5 \
  SCOUT_COMPARE_SOURCE_PIN='{"head":"<TIP>","tree":"<TREE>","pr":78,"ablation":"hide_suggestions"}' \
  npm run eval:scout-model-compare

# Sol next; Fable only if Flip needs third discriminatory model
```

### Consumer-cycle evidence prep (parent-hosted, reversible)

Same product runtime; do **not** change production `BASE_MODEL`. Reversible override:

```bash
SERV_PROFILE_MODEL_SCOUT_PLAN=claude-sonnet-5.5   # or gpt-5.6-sol / claude-fable-5
# unset after Flip — production Mini restored
```

t310 phrase + paraphrase Find → next-check → rematch already executes `/api/match` on owned `searchContextToken` (accepted earlier). Scout sequential now also executes recorded `inventory.search` receipts into D2. Live Autodev inventory still parent-gated; harness receipts are recorded/fixture-provenance only (not live proof).

### Scope tests

- `recorded-inventory-execute.test.ts` — suggestion match → receipt; opt-in apply → D2; no-opt-in still external stop
- sequential D1 search → D2 receipt evidence (`serv-model-compare.test.ts`)
- `plan-user-message` ablation hides suggestions
- prior next-check loop/route/claim suite

### Remaining gaps (honest)

- Recorded receipts in harness ≠ live Autodev full-cycle proof (parent Flip hosted still required).
- Default empty `freshVinCount` is honest for PR63 revision echo — D2 must still ground rejects/replans from immutable empty/dup receipt.
- Consumer Find rematch path already executes match; this tip closes the **scout sequential** echo-stop gap.
- **Disposition: NOT RELEASE READY.** Independent review after parent hosted retest. **Do not merge.**
