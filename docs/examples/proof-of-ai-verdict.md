# Proof of AI — verdict decision (redacted example)

This is a **redacted shape example** of the Proof of AI object after `verdict_decide` and TypeScript guardrail clamp. It matches the fields written by `assembleReport` in `src/server/assemble.ts`. VINs and dollar amounts are placeholders.

> This file is a documentation example of the recorded schema. It is **not** a live SERV network capture. Live measured eval status lives in [`eval/results/verdict-latest.md`](../../eval/results/verdict-latest.md). Offline clamp behavior is covered in [`src/domain/verdict-guardrails.test.ts`](../../src/domain/verdict-guardrails.test.ts).

```json
{
  "version": "autoflip.proof.v1",
  "inputsHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "model": "gpt-5.4-mini-serv-multipath",
  "promptVersion": "report-explain.v1",
  "explanationSource": "serv",
  "steps": [
    { "id": "local_input_screen", "status": "passed" },
    { "id": "serv_prompt_guard", "status": "allow" },
    { "id": "listings", "status": "ok" },
    { "id": "deterministic_tools", "status": "ran" },
    { "id": "serv_verdict_decide", "status": "ok", "detail": "completed" },
    {
      "id": "verdict_guardrails",
      "status": "overrode",
      "detail": "park_it_recall: forced pass (A park-it or park-outside campaign matched this model year.)"
    },
    { "id": "serv_shadow_agent", "status": "completed" },
    { "id": "number_audit", "status": "passed" }
  ],
  "toolOutputs": {
    "verdict": "walk_away",
    "fairValueUsd": 22000,
    "priceGap": -0.12,
    "compCount": 5,
    "score": null,
    "openParkIt": true,
    "verdictDecision": {
      "profile": "verdict_decide",
      "deterministicAction": "pass",
      "deterministicVerdict": "walk_away",
      "servChoice": "buy",
      "finalAction": "pass",
      "finalVerdict": "walk_away",
      "source": "guardrail_clamp",
      "overrideReasons": [
        "park_it_recall: forced pass (A park-it or park-outside campaign matched this model year. Buy and negotiate are forbidden until VIN repair status is confirmed.)"
      ],
      "guardrailIds": ["park_it_recall"],
      "allowedActions": ["pass"],
      "labeledFallback": false,
      "note": "Asking is below fair value of 22000."
    }
  },
  "servChecks": [
    {
      "purpose": "verdict_decide",
      "tools": ["serv_prompt_guard", "serv_shadow_agent"],
      "features": ["multipath", "json_schema"],
      "promptGuard": "allow",
      "shadowOutcome": "completed",
      "shadowMaxIterations": 2,
      "latencyMs": 4200,
      "jsonSchema": "report_verdict_decision",
      "codeComputed": ["fairValueUsd", "priceGap", "compCount", "openParkIt", "score", "allowedActions"]
    }
  ],
  "shadow": {
    "requested": true,
    "hint": "(report explain hint)",
    "maxIterations": 2,
    "outcome": "completed"
  }
}
```

## How to read this

| Field | Owner |
| --- | --- |
| `fairValueUsd`, `priceGap`, `compCount`, `score` | TypeScript only |
| `verdictDecision.servChoice` | SERV (`verdict_decide` profile) |
| `verdictDecision.finalAction` / `finalVerdict` | TypeScript after clamp |
| `verdictDecision.overrideReasons` | TypeScript — why SERV was not allowed to stand |
| `source: guardrail_clamp` | SERV answered, but a hard rail changed the action |
| `source: deterministic_fallback` | SERV failed/timeout; labeled code baseline used instead |
