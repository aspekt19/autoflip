## Summary

**t317 on PR #77** — continue Find vertical slice + prepare operational fair SERV model compare for Flip. **No PR76 touch. No live inference. No self-merge. No PR71 blanket merge** (selective XOR/sequential port only).

### Reviewable head

| Pin | Value |
| --- | --- |
| PR | https://github.com/aspekt19/autoflip/pull/77 |
| Branch | `cursor/t315-clarify-owncost-ecfd-1033` |
| **Head** | `26695fd8d0413781a1c2ecd4df0ee1d8568689c6` |
| **Tree** | `eb682424b95a41fd301751c07f3680b325b483da` |
| Base | `cursor/find-nav-provenance-ecfd-1033` @ `aa1e9010d041105717b19a2a1e36c9ace7f946a8` (**frozen**) |

### Coherent feature state (vertical slice)

| Stage | Status |
| --- | --- |
| NL → need + progressive clarifications (age/miles/condition) | Done (t315) |
| Soft prefs honesty + open/closed paraphrases | Done (PR76/t315) |
| Bounded next checks (`proposeFindNextChecks` + `find_next_check` schema) | Done |
| **Apply check → replan** (`applyFindNextCheck`) | **New** |
| Observed condition/ownership compare | Done (unavailable fuel without EPA; condition unknown) |
| **Grounded shortlist** (constraint filter, not best-car) | **New** (`buildGroundedShortlist` + results UI) |
| Offline slice runner | **New** (`runFindVerticalSliceOffline`) |
| Live SERV find_next_check calls | Not in this PR (parent Flip) |

### Fair SERV model compare (Flip-ready; zero network here)

Exact docs API IDs (https://docs.openserv.ai/serv-reasoning/models):

| Role | Model ID | Provider | Endpoint |
| --- | --- | --- | --- |
| Baseline | `gpt-5.4-mini` | OpenAI | chat |
| Sonnet peer | `claude-sonnet-4.6` | Anthropic | chat |
| Gemini peer | `gemini-2.5-flash` | Google | chat only |

**Harness ready-run (Flip sole spend):**

```bash
# Offline preflight (already green on this head)
npm run eval:serv-compare-preflight

# Fair 3-model SAME PR63 ledger compare
SERV_API_KEY=… SCOUT_COMPARE_ALLOW_PAID=1 SCOUT_COMPARE_FAIR_SLATE=1 \
  SERV_COMPARE_MODELS=gpt-5.4-mini,claude-sonnet-4.6,gemini-2.5-flash \
  npm run eval:scout-model-compare

# Sequential XOR ≤2 HTTP (never stacks on normal)
SERV_API_KEY=… SCOUT_COMPARE_ALLOW_PAID=1 SCOUT_COMPARE_SEQUENTIAL=1 \
  SERV_COMPARE_MODELS=gpt-5.4-mini \
  SCOUT_COMPARE_SOURCE_PIN='{"head":"<HEAD>","tree":"<TREE>","base":"cursor/find-nav-provenance-ecfd-1033"}' \
  npm run eval:scout-model-compare
```

Scoring: schemaValid / grounded / recoveryClass / antiLoopSafe / defect-from-placeholder + rawStatus / latencyMs / tokens / refusals / timeouts; **cost=unknown**.

### Protocol issues (integration vs model)

| ID | Class | Notes |
| --- | --- | --- |
| `anthropic_nullable_enum` | integration | Fixed anyOf on lineage — 400 with old shape ≠ model fault |
| `gemini_endpoint` | integration | Gemini not on messages/responses — scout_plan chat ✓ |
| `servstepid_execution_owned` | integration | exec:step-N bind; empty string was schema |
| `sequential_xor_bound` | integration | XOR dispatch ported from PR71 reviewed tip (no blanket merge) |
| `gpt54_cold_timeout` | unknown_until_live | Record timeout row; do not blind-raise |
| `grounding_vs_http200` | model_behavior | Score recovery, not HTTP 200 alone |

Artifact: `eval/results/serv-compare-preflight.md`

### Offline evidence
- `npm run typecheck` + `npm test` → **681** passed
- `npm run eval:serv-compare-preflight` → dry-run OK, 0 HTTP

### Explicitly not done / blockers
- Flip must confirm console enablement of fair-slate IDs before paid run
- Live fair compare + sequential probe = Flip only
- PR76 merge owned by child `bc-7832d685` — untouched
- No invented TCO/history/best-car; BASE_MODEL unchanged

## Test plan
- [x] typecheck + vitest 681
- [x] eval:serv-compare-preflight (offline)
- [ ] Parent updates PR #77 body from this artifact
- [ ] Flip live fair compare after console check
- [ ] HOLD merge until owner ACCEPT
