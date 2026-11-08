# Flip t318 decision / tool replay pack

Frozen offline SAME-input pack for parent Flip sequential SERV on PR #77.

- **Shortlist:** claude-sonnet-5.5, gpt-5.6-sol, claude-fable-5
- **Ledger:** `fixtures/scout/pr63-placeholder-ledger.json`
- **Decision-1 user sha256:** `20d455dbac92aa060414866e042cf680aafa2075c8fbca789ef7f0f09b83afb8`
- **scout_plan system sha256:** `83c90726a0dc9985468fd69d17f2e192823a4f2a0a273caf553bc5e18d7d936a`
- **canReviseSearch:** true
- **Cycle FAIL example:** `premature_stop_after_single_reject` (reject then abstain)
- **Cycle PASS example:** `progress_grounded_reject_then_revise`

See `COMMANDS.md` for Flip-only paid sequential runs. This freeze is zero-network.

Production `BASE_MODEL` remains `gpt-5.4-mini` until independent review + Flip cycle.
