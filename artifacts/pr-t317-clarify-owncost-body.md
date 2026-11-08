## Summary

**t317/t318 CORE on PR #77** — Flip decides models; CORE vertical slice continues. Frozen Flip SAME-input decision/tool replay pack for shortlist **Sonnet 5.5 → gpt-6.1-sol → Opus 5.5** (exact console CSV IDs). **No hosted SERV/provider calls in this agent.** Production `BASE_MODEL` remains Mini.

### Reviewable tip

| Pin | Value |
| --- | --- |
| PR | https://github.com/aspekt19/autoflip/pull/77 |
| Branch | `cursor/t315-clarify-owncost-ecfd-1033` |
| Base | `main` @ `0aeed3b3fc7611be47eab0eff6b737a9abf869bd` (PR76 published) |
| **Implement tip** | `b45a428ab0ecbefe52ecea252c58f93cc9cadb84` / tree `796e510345c1efd45115bda85391b4ac0aa03736` |
| **Branch tip** | *(docs tip after push — ready review = implement tip)* |
| **CI** | pending after push — parent reconciles |

### Flip t318 shortlist (exact console `model_id`)

| Order | ID | Display | Context | In/M | Out/M | Role |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `claude-sonnet-5.5` | Claude Sonnet 5.5 | 1M | $2.40 | $12.00 | baseline |
| 2 | `gpt-6.1-sol` | GPT-6.1 Sol | 1M | $2.40 | $12.00 | next |
| 3 | `claude-opus-5.5` | Claude Opus 5.5 | 1M | $4.80 | $24.00 | next_if_needed |

Source: `uploads/all-models-20261108_c8cc.csv` + readme (31 Available models). Display prices ≠ capability. **No 31-model blind paid matrix.**

### Pack (parent Flip sequential SERV)

- **Path:** `artifacts/flip-t318-decision-pack/`
- **Freeze:** `npm run eval:flip-t318-decision-pack` (zero network)
- **Commands:** `artifacts/flip-t318-decision-pack/COMMANDS.md`
- **Pins:** PR63 ledger `fixtures/scout/pr63-placeholder-ledger.json`; D1 user sha `20d455db…`; system sha `83c90726…`; `canReviseSearch=true`
- **Live (Flip only, ≤2 HTTP / model, XOR sequential):**
  ```bash
  SERV_API_KEY=… SCOUT_COMPARE_ALLOW_PAID=1 SCOUT_COMPARE_SEQUENTIAL=1 \
    SERV_COMPARE_MODELS=claude-sonnet-5.5 \
    SCOUT_COMPARE_SOURCE_PIN='{"head":"b45a428ab0ecbefe52ecea252c58f93cc9cadb84","tree":"796e510345c1efd45115bda85391b4ac0aa03736","pr":77,"pack":"artifacts/flip-t318-decision-pack"}' \
    npm run eval:scout-model-compare
  ```
  Then `gpt-6.1-sol`, then `claude-opus-5.5` if needed — one at a time.

### CORE product (this tip)

| Change | Detail |
| --- | --- |
| Flip shortlist allowlisted | Console IDs resolve without `ALLOW_UNLISTED`; profile candidates include same IDs |
| `scoreFlipCycleProgress` | FAIL `premature_stop_after_single_reject`; PASS `progress_grounded_reject_then_revise` |
| Prior t317 | Sonnet profile override; Gemini `content_null_refusal_field` + usage; searchContinuation clamp |
| Gemini prerequisite | Diagnostic before any blind Gemini retry; no format/safety RCA claim |

### Parent evidence folded (not re-run)

Mini false-terminal abstain; Sonnet D1 grounded reject + D2 abstain (no replacement); Gemini content-null/refusal ~19 chars / tokens null. Console reconcile pending.

### Offline evidence
- `npm run typecheck` + `npm test` → **700** passed
- Pack freeze + shortlist resolve OK

### Not claimed
Full-cycle Scout success; model winner; invented usable inventory; capability from price/tier; production flipped off Mini; PR71 as proof.
