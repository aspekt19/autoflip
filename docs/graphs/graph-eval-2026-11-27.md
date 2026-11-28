# Find decide graph — live runs (Nov 27, 2026)

Two graphs were evaluated: v2 (`gr_3d039bd8de63381a`) and v3 (`gr_28beee6b8bffe5a9`, production since Nov 28). v2 results: `eval/results/graph-vs-baseline-v2.json`; v3 results: `eval/results/graph-vs-baseline.json`. After v3 shipped as a second check, the same graph became the primary final Find decider; that comparison is `eval/results/graph-primary-vs-second-check.json`.

Graph: `gr_3d039bd8de63381a` ("Lemonless Find decide v2"), generated from `find-decide-graph-prompt.txt`: 15 nodes (4 agents, 7 decisions, 4 scripts). Results: `eval/results/graph-vs-baseline-v2.json` (10 frozen cases × 2 repeats × 3 arms).

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

## What shipped with v2

The second check after the agentic Find loop is on in production with `SERV_GRAPH_FIND_DECIDE_ID=gr_3d039bd8de63381a`. The run gets at most 90 s (p95 here is under 15 s). Any failure still leaves "Second check not run" with the reason and never blocks the answer. Next improvement: regenerate the graph with a prompt that separates "negotiate on price" from "inspect first", so the second check stops treating every non-buy as an inspection.

## v3 (`gr_28beee6b8bffe5a9`)

Prompt v3 defines each action by the evidence (price lever → negotiate; a specific risk an inspection would settle → inspect_first, named in the reply; missing data alone is not a reason to inspect). The console generated 13 nodes (3 agents, 7 decisions, 3 scripts) and a new input schema (`src/server/serv/find-decide-graph-input-v3.schema.json`): numbers as numbers, recalls as a list, only the upper bound of the fair range, and a slot `car_1`…`car_5` per car. The graph's selection steps return slots, so code assigns unique slots, sends at most 5 cars (the loop's pick first, then code rank), and maps a slot answer back to its key from its own map; an unknown slot makes the answer invalid. The app picks the input schema by graph id (`SERV_GRAPH_FIND_DECIDE_INPUT=v2|v3` overrides it for a new id).

Same 10 cases × 2 repeats:

| | v2 graph | v3 graph | v2 second check | v3 second check |
| --- | --- | --- | --- | --- |
| Valid | 20/20 | 20/20 | 20/20 | 20/20 |
| inspect_first | 19/20 | 5/20 | 20/20 | 2/20 |
| negotiate / buy / pass | 0 / 0 / 1 | 11 / 3 / 1 | 0 / 0 / 0 | 12 / 5 / 1 |
| Same car as the two-call path | 9/10 | 10/10 | — | — |
| Same car + action as the two-call path | 6/10 | 6/10 | — | — |
| Same car as the loop stand-in | — | — | 8/10 | 8/10 |
| Agreed with the loop stand-in (`negotiate`) | — | — | 0/20 | 8/20 |
| Repeat consistency | 0.90 | 0.80 | 0.90 | 0.85 |
| Latency p50 / p95 | 11.8 s / 13.5 s | 13.9 s / 16.6 s | 11.6 s / 14.6 s | 13.1 s / 14.9 s |
| Tokens (provider) | 549,990 | 525,753 | 491,431 | 458,335 |

The two-call path in the v3 run: 19/20 valid (one run gave no decision), `inspect_first` 13 and `negotiate` 6, p50 18.4 s; three of its calls took 288–553 s, which is the two-call path, not the graph.

`buy` appeared 8 times out of 40 v3 answers, always on cars whose frozen listings report no accident or recall (these fixtures carry no accident or recall data), and with low or medium confidence. A separate check with a synthetic shortlist where the cheapest car had 2 reported accidents (2 runs) moved the pick to the clean car with `negotiate` both times. v3 is less consistent across repeats than v2 (0.80 vs 0.90): with the action no longer pinned to `inspect_first`, it varies between `negotiate` and `buy` on borderline prices.

The reply's trailing `Evidence:` line is now parsed for ids and removed from the shopper-facing reason.


## Graph as the primary Find decider (Nov 28, 2026)

The agentic Find loop still gathers listings, public-record facts and a shortlist, and it still produces a tentative pick. The published pick, action and confidence now come from graph v3, validated and capped in code. The loop's pick is the fallback when the graph cannot run, with "Decided by fallback:" and the reason in the journal and the trail. No extra search credit is charged. Implementation: `src/server/find-graph-decide.ts`, used by the Find chat and `/api/find/decide`.

Same 10 frozen cases × 2 repeats, compared with the previous production path (loop pick published, graph as second check). The loop pick is a frozen stand-in (code's top-ranked car, `negotiate`, high). A 3-case smoke run was 3/3 graph-decided with 0 fallbacks before this table. Results: `eval/results/graph-primary-vs-second-check.json`.

| | Previous path (loop + second check) | Graph as the final decider |
| --- | --- | --- |
| Valid (graph answer accepted) | 20/20 | 20/20 |
| Fallbacks (loop pick published) | — | 0/20 |
| inspect_first / negotiate / buy / pass | 2 / 12 / 4 / 2 | 2 / 12 / 4 / 2 |
| Same car as the loop stand-in | 8/10 (graph's own pick) | 9/10 (published pick) |
| Same car + action as the loop stand-in | 8/20 | 10/20 |
| Repeat consistency | 0.85 | 0.90 |
| Latency p50 / p95 | 13.6 s / 15.1 s | 13.0 s / 17.4 s |
| Tokens (provider) | 453,545 | 415,081 |

`buy` appeared 4 times out of 20 graph-as-decider answers, on two cars whose frozen listings report no accident or recall (these fixtures carry no accident or recall data), with low or medium confidence: a 2014 Camry with 118,000 miles (low) and a 2018 Camry with 18,000 miles (medium). Latency stays well inside the 90-second graph budget and the 300-second route. The graph run id and step count are recorded on the decision step and in the proof record; the main shopper trail says "Decided by the SERV graph."
