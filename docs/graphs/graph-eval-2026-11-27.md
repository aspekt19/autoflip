# Find decide graph — first live run (Nov 27, 2026)

Graph: `gr_3d039bd8de63381a` ("Lemonless Find decide v2"), generated from `find-decide-graph-prompt.txt`: 15 steps (4 agents, 7 decisions, 4 scripts). Results file: `eval/results/graph-vs-baseline.json` (3 frozen cases, 1 repeat, all three arms).

| Arm | Validator pass | Latency p50 / p95 | HTTP calls | Tokens (provider) | Cost |
| --- | --- | --- | --- | --- | --- |
| two_call (find_decide + find_challenge) | 3/3 | 18.1 s / 18.7 s | 6 | 22,515 | not returned |
| graph (one run, fallback to two_call) | 0/3 (all 3 fell back) | 21.9 s / 23.4 s incl. fallback | 9 | 22,472 (fallback calls only) | not returned |
| loop_second_check (production path) | 0/3 | 5.6 s / 5.8 s | 3 | not returned | not returned |

Every graph run in the eval ended in HTTP 502 "Graph run failed. Please retry." after about 5 seconds, before any reply. Nothing was blocked: the graph arm fell back to the two-call path, and the second check recorded "Second check not run: the graph check did not answer."

Outside the eval, the same input sent directly twice gave one 502 (6.4 s) and one complete run (20.4 s, 35,187 tokens) with the expected reply:

```
Pick: 2HKRM4H75FH123456
Action: inspect_first
Confidence: medium
Review: kept; inspection warranted
The 2015 CR-V beats the 2014 CR-V on age and mileage, … Evidence: car:2HKRM4H75FH123456, ask:…, fair:…
```

The parser reads that reply and it passes the validators. So the reply format works; the run itself fails early most of the time (1 success in 8 runs). Decision agreement and repeat consistency cannot be measured until runs complete.

What this means for production: the second check stays off (`SERV_GRAPH_FIND_DECIDE_ID` is not set). Next step is the failing step in the console Runs panel for the run ids in the results file, then a fix to the graph or its input before another run.

Settings kept: at most 6 cars go to the graph (11 fixed steps + 2 per car, twice on a revised branch, stays under the 50-visit budget); the run gets at most 90 s, which leaves room over the 20 s complete run seen here.
