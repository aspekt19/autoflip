# Find decide graph — live runs (Nov 27, 2026)

Graph: `gr_3d039bd8de63381a` ("Lemonless Find decide v2"), generated from `find-decide-graph-prompt.txt`: 15 nodes (4 agents, 7 decisions, 4 scripts). Results: `eval/results/graph-vs-baseline.json` (10 frozen cases × 2 repeats × 3 arms).

## First attempt: 7 of 8 runs failed before any step

Every failure was input validation (0 steps, about 5 s, HTTP 502). We sent our own `{ facts }` object, so the platform's input mapper had to rebuild it into the graph's input schema with a model call. It left out `evidence_records` (5 runs) or wrote non-string `content` (2 runs). The one success was a run where the mapper got it right.

Fix: code now builds the graph's own input (`shopper_requirements`, `permitted_car_keys`, `cars`, `evidence_records`) deterministically (`src/server/find-decide-graph-input.ts`), checks it against the schema copied from the console (`src/server/serv/find-decide-graph-input.schema.json`), and sends it as the JSON string in `instructions`. Numbers are formatted as text, unknown values stay null, and the guardrail rules and the code-ranked key are carried in `shopper_requirements`. The platform runs a matching input as is, so no mapping call is made. At most 6 cars go to the graph to stay inside the 50-visit budget.

## After the fix

46 graph runs (6 in a 3-case check, then 40), 46 complete, 0 failures, 0 fallbacks.

| Arm | Valid | Repeat consistency | Latency p50 / p95 | HTTP calls | Tokens (provider) |
| --- | --- | --- | --- | --- | --- |
| two_call (find_decide + find_challenge) | 20/20 | 0.95 | 18.3 s / 24.4 s | 40 | 140,440 |
| graph (one run) | 20/20 | 0.90 | 11.8 s / 13.5 s | 20 | 549,990 |
| loop_second_check (production path) | 20/20 | 0.90 | 11.6 s / 14.6 s | 20 | 491,431 |

- Same pick + action as the two-call path: 6 of 10 cases. Same pick only: 9 of 10.
- Actions: the graph chose `inspect_first` in 39 of 40 runs and `pass` once; the two-call path chose `inspect_first` 13 times and `negotiate` 7 times. The console flagged this at generation ("any case that is not clearly buy is routed to inspect_first"), and the runs confirm it.
- Second check: against the frozen loop stand-in (top code-ranked car, `negotiate`, high confidence) the graph kept the same car in 8 of 10 cases and disagreed on the action every time, because it answers `inspect_first`. In production that shows as "Second check disagreed" with the graph's objection; the loop's pick and action stay, and the published confidence drops to the lower of the two (the graph answered low in 29 of 40 runs).
- Cost: the provider returns tokens but no price. The console showed $0.004 for a complete run, about 27,000 tokens; the graph uses about 4 times the tokens of the two-call path and is about 6 s faster.

## What ships

The second check after the agentic Find loop is on in production with `SERV_GRAPH_FIND_DECIDE_ID=gr_3d039bd8de63381a`. The run gets at most 90 s (p95 here is under 15 s). Any failure still leaves "Second check not run" with the reason and never blocks the answer. Next improvement: regenerate the graph with a prompt that separates "negotiate on price" from "inspect first", so the second check stops treating every non-buy as an inspection.
