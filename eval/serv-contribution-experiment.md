# SERV contribution experiment — protocol

Status: **prepared, not executed**. This document defines the experiment and the evidence required before publishing a SERV-impact claim. It does not report results.

## Research question

On identical vehicle-search inputs and identical evidence, what measurable contribution does OpenServ SERV make to Lemonless decisions beyond deterministic TypeScript logic and beyond a single-pass LLM?

The experiment must distinguish three things:

1. Product value: does Lemonless produce a useful, grounded vehicle recommendation?
2. SERV decision value: does SERV improve the final decision when the evidence is held fixed?
3. SERV agent value: does the full SERV tool loop improve the evidence gathered or the decision through planning, tool selection, evaluation, and recovery?

A result for (1) or (2) must not be presented as proof of (3).

## Canonical Proof scenario

All arms in the initial public-facing experiment use this exact request verbatim (including punctuation):

> I'm in Denver 80202, budget $25k all-in, need an AWD SUV for mountain winters and a 40-mile daily commute. Two kids, so safety matters most. Under 100k miles, no accident or salvage history, low fuel cost. Within 75 miles. Which one should I buy and what should I offer?

Do not paraphrase, shorten, translate, or silently normalize this prompt between arms. Store the UTF-8 prompt bytes and SHA-256 in the experiment manifest. The same confirmed structured brief derived from this request must be supplied to every arm; record it separately so any parser differences are visible rather than hidden.

The initial Denver scenario should use one timestamped, frozen inventory/comps cassette. The earlier Proof Find run (2026-11-13, run ID `run_2e88e0fb64f74f818f31`) is historical context only; do not treat it as the paired cassette unless its complete raw tool responses, source timestamps, and hashes are available and verified. Do not launch separate live inventory searches for the A/B arms.

For this first experiment, keep the canonical prompt as the primary case. Additional stress scenarios may be added later, but report them separately and never blend them into the Denver result.

## Existing infrastructure reviewed

- `npm run eval:serv-vs-baseline` → `scripts/eval-serv-vs-baseline.ts`
- `eval/comparison/arms.ts` contains deterministic Lemonless, live SERV verdict, and plain-LLM arms.
- `eval/comparison/fixtures/find-cases.json` contains 10 Find cases. The fixtures currently identify themselves as synthetic.
- `eval/results/serv-vs-baseline-latest.json` is an older dry-run. It is not a live SERV-vs-LLM result: the plain-LLM arm is `not_run`, while the Lemonless arm is deterministic.
- The current live comparison path first selects a candidate with deterministic `selectBestDealOnEvidence`, then sends that selected candidate through `verdict_decide` and `verdict_challenge`. The plain-LLM arm sees the full shared listing payload. This is useful as a narrow verdict-layer probe, but it is **not** a controlled test of the full Find agent loop or SERV's inventory-search planning.
- Existing Find run traces can demonstrate actual SERV/tool execution, but two independent live searches are not a controlled A/B experiment unless both arms receive the same frozen evidence snapshot.

## Experiment design

### Track A — fixed-evidence decision comparison

Purpose: isolate the incremental effect of SERV's final verdict reasoning.

Arms:

| Arm | Behavior |
| --- | --- |
| A0 — deterministic | Production TypeScript ranking, calculations, and hard gates; no model verdict call |
| A1 — plain LLM | One LLM completion receives the same frozen query, listings, and comparable listings; no tools |
| A2 — SERV verdict | The same deterministic TypeScript evidence and hard gates, followed by production `verdict_decide` and `verdict_challenge` |

Controls:

- All arms receive byte-identical user request, candidate listing snapshot, and comparable-listing snapshot.
- A1 and A2 use the same model ID, inference provider, and output schema where the API supports it.
- No arm receives evaluation labels, expected picks, or scoring annotations.
- TypeScript calculations and hard constraints are held constant; record model output separately from deterministic overrides.
- Run order is interleaved (A1/A2, then A2/A1) to reduce time/order effects.
- Record every error, timeout, refusal, parse failure, fallback, and abstention. Do not silently drop failed rows.
- Do not call independent inventory search inside this track.

Suggested first batch: 10 cases × 2 repetitions for A1 and A2, plus A0 once per case. The existing 10 synthetic fixtures can validate the mechanics, but **must not be represented as live marketplace evidence**. For judge-facing claims, replace or supplement them with a consented, timestamped snapshot of real listings and clearly report the synthetic/real split.

### Track B — full Find agent contribution

Purpose: show SERV's actual orchestration contribution: request interpretation, planning, tool choice, evidence evaluation, retry/recovery, and final verdict.

Required arms:

- B0 — no-SERV control: the same frozen tool-response cassette is processed by the deterministic workflow without SERV planning or model-directed tool selection.
- B1 — SERV agent: the production Find SERV loop chooses tools and next actions against a replay adapter that returns the exact same recorded tool responses.

The replay adapter must be deterministic and keyed by tool name plus normalized arguments. It must record requested tools, arguments, response IDs, result hashes, sequence, and whether a response was served from the cassette. An unmatched request must fail closed and be logged; it must not silently fetch new inventory.

For each scenario, freeze:
- exact user prompt and confirmed brief;
- initial inventory result(s) and all downstream tool responses;
- source URLs, retrieval timestamps, and response hashes;
- tool availability and timeout/error conditions;
- application version, SERV profile, model ID, and configuration.

This track requires a replay seam in the Find tool executor if the current production handler cannot inject a cassette without changing business logic. Do not claim Track B was run until that adapter exists and both arms consumed the same cassette.

Suggested scenarios:
1. The Denver AWD family-SUV request used in the Proof comparison.
2. A hard-constraint conflict (e.g. all-in budget versus listing price).
3. A misleading or stale listing (sold/implausible price).
4. Incomplete evidence requiring an honest abstention or a targeted retry.
5. A request with competing soft preferences (safety, fuel economy, mileage).

Use the same scenario set for both arms. Report each case individually; aggregate only after verifying the paired inputs.

## Scoring rubric

Score from hidden labels and independently checked evidence, never from the model's own explanation.

| Metric | What is measured |
| --- | --- |
| Hard-constraint compliance | AWD/body/mileage/radius/budget constraints satisfied or correctly rejected |
| Evidence grounding | Selected VIN and claims trace to the frozen source rows |
| Safety/risk handling | Known sold, title, accident, recall, or identity flags handled correctly; unknown is not treated as clean |
| Price reasoning | Fair-value band and offer are consistent with the frozen comps; asking prices are not described as sold prices |
| Budget discipline | All-in budget is not confused with vehicle asking price |
| Abstention quality | Withholds recommendation when required evidence is insufficient |
| Recovery quality | A retry obtains relevant missing evidence without loops or unsupported claims |
| Tool efficiency | Relevant tool calls/rounds, duplicate calls, and unnecessary calls |
| Reliability | Schema validity, completion rate, timeouts, parse failures, and fallbacks |
| Cost/latency | Measured provider usage and wall-clock latency; unknown cost remains unknown |

Primary outcome: **case-level grounded decision pass rate**, with hard-constraint violations and unsupported factual claims reported separately. Do not use raw number of SERV calls as a quality metric.

For each case, preserve the individual result and adjudication. Have the labels checked independently of the person who authored the fixture where practical. Resolve disagreements before computing totals.

## Evidence to retain

For every arm and case, save:

- experiment ID, timestamp, git SHA, fixture/cassette hash;
- prompt and exact shared input (with secrets and personal data redacted);
- requested and effective model IDs, profile, and relevant feature settings;
- raw structured output and parsed output;
- SERV/OpenServ response IDs and tool-call trace;
- tool names, normalized arguments, response hashes, and replay/live status;
- token usage, latency, retries, fallbacks, and errors;
- hidden-label scorecard and adjudication notes in a separate file not passed to any arm.

Never commit API keys, auth headers, private customer data, or unredacted sensitive payloads.

## Run gates

1. Run offline tests first:
   ```bash
   npm test -- scripts/eval-serv-vs-baseline.test.ts
   npm run eval:serv-vs-baseline -- --dry-run
   ```
   Dry-run validates fixture loading and report shape only. It does **not** test model quality or SERV reasoning.
2. Validate Track A on synthetic fixtures; inspect every row for identical inputs and correct arm behavior.
3. Add real captured listings and independently reviewed labels before a judge-facing live comparison.
4. Implement and test the Track B replay adapter before making claims about planning/tool-selection impact.
5. Run paid inference only in a trusted environment with the existing secret configured. Never put keys in chat, commits, or artifacts.
6. Publish the report only after all paired runs complete. Include failures and clearly label synthetic vs real cases.

## Publication rule

The Proof page may state only what the completed experiment supports:

- Track A supports a claim about the **verdict layer on fixed evidence**.
- Track B supports a claim about the **full SERV agent loop** only if both arms consumed the same frozen tool-response cassette.
- A separate live Find trace supports that SERV and tools executed in a real workflow, but by itself does not prove that SERV outperformed a baseline.

Until a live paired experiment is completed, label this protocol as prepared and do not display a winner, score, or performance percentage.
