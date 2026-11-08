# Flip t318 decision pack — parent commands (spends SERV)

**Pack path:** `artifacts/flip-t318-decision-pack/`
**Offline freeze:** `npm run eval:flip-t318-decision-pack` (this agent; zero network)

## Shortlist (exact console IDs — order matters)

1. `claude-sonnet-5.5` (Claude Sonnet 5.5) role=baseline — in=$2.40 out=$12.00 (display only)
2. `gpt-5.6-sol` (GPT-5.6 Sol) role=next — in=$5.25 out=$25.00 (display only)

Do **not** run all 31 Available models. Names/tier ≠ ability proof.

## 0) Offline dry-run (safe)

```bash
npm run eval:flip-t318-decision-pack
SERV_COMPARE_MODELS=claude-sonnet-5.5,gpt-5.6-sol npm run eval:scout-model-compare
```

## 1) Sequential TWO-decision XOR per shortlist ID (≤2 HTTP each; Flip sole spend)

Run **one model at a time** in flipOrder. XOR: SCOUT_COMPARE_SEQUENTIAL=1 skips normal compare.
D1 inventory.search matching suggestions is **executed** (recorded immutable receipt) → Decision-2 sees tool evidence.

```bash
# Baseline — Claude Sonnet 5.5
SERV_API_KEY=… SCOUT_COMPARE_ALLOW_PAID=1 SCOUT_COMPARE_SEQUENTIAL=1 \
  SERV_COMPARE_MODELS=claude-sonnet-5.5 \
  SCOUT_COMPARE_SOURCE_PIN='{"head":"<IMPLEMENT_TIP>","tree":"<IMPLEMENT_TREE>","pr":78,"pack":"artifacts/flip-t318-decision-pack"}' \
  npm run eval:scout-model-compare

# Next — GPT-5.6 Sol
SERV_API_KEY=… SCOUT_COMPARE_ALLOW_PAID=1 SCOUT_COMPARE_SEQUENTIAL=1 \
  SERV_COMPARE_MODELS=gpt-5.6-sol \
  SCOUT_COMPARE_SOURCE_PIN='{"head":"<IMPLEMENT_TIP>","tree":"<IMPLEMENT_TREE>","pr":78,"pack":"artifacts/flip-t318-decision-pack"}' \
  npm run eval:scout-model-compare

# Ablation (no prefilled suggestions) — discriminatory multistep
SERV_API_KEY=… SCOUT_COMPARE_ALLOW_PAID=1 SCOUT_COMPARE_SEQUENTIAL=1 \
  SCOUT_COMPARE_HIDE_SUGGESTIONS=1 \
  SERV_COMPARE_MODELS=claude-sonnet-5.5 \
  SCOUT_COMPARE_SOURCE_PIN='{"head":"<IMPLEMENT_TIP>","tree":"<IMPLEMENT_TREE>","pr":78,"ablation":"hide_suggestions"}' \
  npm run eval:scout-model-compare

# claude-fable-5 EXCLUDED from paid Flip / production selection (owner t321)
```

## Call accounting / failure contract

- Transport: `experiment_single_attempt` — record FAIL / timeout / empty / refusal; no silent re-POST
- Usage: `normalizeCompareUsageLoose` + failureDiag (category/reasonCode/refusalBytes) — never raw refusal
- cost=`unknown` until billing reconcile
- Production `BASE_MODEL=gpt-5.4-mini` unchanged; profile override via `SERV_PROFILE_MODEL_SCOUT_PLAN` if Flip opts

## Gemini prerequisite (before any blind Gemini retry)

Parent Gemini 3.1 Pro Preview: content-null + ~19-char refusal field. Require `content_null_refusal_field` diagnostic + usage repair. Refusal cause **not known** — do not assert format vs safety RCA. No blind Gemini rerun from this pack.

## Product cycle criteria (pass/fail)

- PASS example offline: grounded reject → revised inventory.search → `progress_grounded_reject_then_revise`
- FAIL example offline: grounded reject → abstain while canReviseSearch → `premature_stop_after_single_reject`
- See `CRITERIA.json`

## Not in this pack

- No PR71 blanket merge / PR71-as-only-proof
- No Graph / new services / cosmetics
- No hosted calls from the pack-freeze agent
