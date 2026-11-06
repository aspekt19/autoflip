# Redacted SERV Proof of AI trace

Real SERV inference execution against Lemonless's fixed flip-clear evaluation fixture. This is not live customer traffic or a production vehicle report. Raw prompt, VIN, supplied facts, and free-form response text are intentionally omitted.

| Field | Recorded value |
| --- | --- |
| Scenario | flip-clear (fixed evaluation fixture) |
| Profile | flip_judge |
| Inference succeeded | yes |
| HTTP status | 200 |
| SERV decision | alert |
| Requested model | gpt-5.4-mini-serv-multipath |
| Reported model | gpt-5.4-mini-2026-03-17 |
| Features | multipath |
| Tools | serv_prompt_guard, serv_shadow_agent |
| Prompt guard record | passed |
| Shadow outcome | not_exposed |
| Shadow iteration cap | 2 |
| Latency | 11522 ms |
| Response ID | chatcmpl-EhAeeqtS7VTM5hgmyZxDbdz7quzxo |
| Token usage | {"promptTokens":532,"completionTokens":347,"totalTokens":879} |
| Code-computed fields | profitLowUsd, profitMidUsd, profitHighUsd, compCount, speed |
| Deterministic fallback used | no |

No prompt, VIN, source facts, or free-form model output is stored in this trace.
