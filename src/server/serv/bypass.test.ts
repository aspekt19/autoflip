import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DOCUMENTED_FEATURES, PROFILES, featuresUsedBy, requestFor, runServ, type ProfileId, type ServProfile } from "./index";
import { agentReport } from "@/server/agent-report";
import { buildSampleReport } from "@/server/sample-report";
import { paymentRequiredBody, radarToolResult } from "@/server/mcp";
import { agentProof, buildServProof, chatCompletionContent, openservReportFrom } from "./index";
import { messageText, responseShape, servErrorSummary, toolCall } from "./run";

function filesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...filesUnder(full));
    else if (/\.(ts|tsx)$/.test(entry)) found.push(full);
  }
  return found;
}

describe("SERV layer", () => {
  it("sends every model call through a profile", () => {
    const root = path.join(process.cwd(), "src");
    const offenders: string[] = [];
    for (const file of filesUnder(root)) {
      if (file.includes(`${path.sep}server${path.sep}serv${path.sep}`)) continue;
      const text = readFileSync(file, "utf8");
      if (/postServ\s*\(/.test(text) || text.includes("inference-api.openserv.ai") || text.includes("/chat/completions") || text.includes("/responses")) {
        offenders.push(path.relative(process.cwd(), file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("builds the documented tool shape and suffix for each profile", () => {
    const extract = requestFor("need_extract", "family car");
    expect(extract.endpoint).toBe("chat");
    if (extract.endpoint !== "chat") return;
    expect(extract.stream).toBe(false);
    expect(extract.model).toBe("gpt-5.4-mini");
    expect(toolNames(extract.tools)).toEqual(["serv_prompt_guard"]);
    expect(extract.response_format?.json_schema.strict).toBe(true);

    const flip = requestFor("flip_judge", "{}");
    expect(flip.endpoint).toBe("chat");
    if (flip.endpoint !== "chat") return;
    expect(flip.model).toBe("gpt-5.4-mini-serv-multipath");
    expect(flip.stream).toBe(false);
    expect(toolNames(flip.tools)).toEqual(["serv_prompt_guard", "serv_shadow_agent"]);
    const guardParams = (flip.tools[0]!.function as unknown as { parameters: Record<string, unknown> }).parameters;
    expect(guardParams.additionalProperties).toBe(false);
    expect(guardParams.required).toEqual([]);
    const hint = (flip.tools[1]!.function as unknown as {
      parameters: {
        properties: { hint: { default?: string; enum?: string[] }; max_iterations: { default?: number; enum?: number[] } };
        additionalProperties: boolean;
        required?: string[];
      };
    }).parameters;
    expect(hint.additionalProperties).toBe(false);
    expect(hint.required).toEqual(["hint", "max_iterations"]);
    // Documented shadow form uses `default`, not single-value `enum`.
    expect(hint.properties.hint.default).toMatch(/estimate/i);
    expect(hint.properties.max_iterations.default).toBe(2);
    expect(hint.properties.hint.enum).toBeUndefined();
    expect(hint.properties.max_iterations.enum).toBeUndefined();
    expect(JSON.stringify(hint)).toMatch(/"default"\s*:/);
    const schema = flip.response_format?.json_schema.schema as {
      properties: { decisions: { items: { properties: { verdict: { enum: string[] } } } } };
    };
    expect(schema.properties.decisions.items.properties.verdict.enum).toEqual(["alert", "skip"]);

    for (const id of ["report_explain", "agent_explain"] as const) {
      const request = requestFor(id, "facts");
      expect(request.model).not.toMatch(/serv-kronos/);
      expect(request.stream).toBe(false);
      expect(toolNames(request.tools)).toContain("serv_shadow_agent");
      expect(toolNames(request.tools)).toContain("read_computed_facts");
    }
    const personal = requestFor("personal_alert_review", "alert");
    expect(personal.endpoint).toBe("chat");
    if (personal.endpoint === "chat") expect(personal.reasoning_effort).toBe("none");
    expect(personal.stream).toBe(false);
    expect(toolNames(personal.tools)).toContain("serv_shadow_agent");
    expect(toolNames(personal.tools)).not.toContain("read_computed_facts");
    const telegram = requestFor("telegram_reply", "help");
    expect(telegram.stream).toBe(true);
    expect(toolNames(telegram.tools)).toEqual(["serv_prompt_guard"]);
    expect(toolNames(telegram.tools)).not.toContain("serv_shadow_agent");

    const rules = requestFor("check_rules", "vin");
    expect(rules.endpoint).toBe("responses");
    if (rules.endpoint !== "responses") return;
    expect(rules.model).toBe("gpt-5.4-mini-serv-kronos");
    expect(rules.reasoning.summary).toBe("auto");
    expect(rules.stream).toBe(false);

    const feasibility = requestFor("flip_feasibility", "facts");
    expect(feasibility.model).toBe("gpt-5.4-mini-serv-kronos");
    expect(toolNames(feasibility.tools)).toEqual(["serv_prompt_guard"]);
    expect(feasibility.endpoint).toBe("chat");
    expect("response_format" in feasibility).toBe(false);
    expect(Object.keys(PROFILES)).toEqual(
      expect.arrayContaining([
        "need_guard",
        "need_extract",
        "check_guard",
        "listing_extract",
        "report_guard",
        "report_explain",
        "agent_guard",
        "agent_explain",
        "radar_guard",
        "personal_alert_review",
        "flip_judge",
        "scout_plan",
        "verdict_decide",
        "verdict_challenge",
        "find_close_call_multipath",
        "find_next_check",
        "resale_plan_search",
        "resale_triage",
        "resale_pick",
        "resale_challenge",
        "radar_review",
        "telegram_reply",
      ]),
    );
    expect(PROFILES.verdict_challenge.jsonSchema?.name).toBe("report_verdict_challenge");
    expect(PROFILES.find_close_call_multipath.feature).toBe("multipath");
    expect(PROFILES.find_next_check.jsonSchema?.name).toBe("find_next_check_choice");
    expect(PROFILES.find_next_check.codeComputed).toEqual(
      expect.arrayContaining(["allowedChecks"]),
    );
    expect(PROFILES.scout_plan.jsonSchema?.name).toBe("lemonless_scout_plan_action");
    expect(PROFILES.scout_plan.feature).toBe("none");
    expect(toolNames(requestFor("scout_plan", "{}").tools)).toEqual(["serv_prompt_guard"]);
    expect(PROFILES.verdict_decide.feature).toBe("multipath");
    expect(PROFILES.verdict_decide.jsonSchema?.name).toBe("report_verdict_decision");
  });

  it("rejects chat function tools that still ask for reasoning effort", () => {
    const offenders = (Object.keys(PROFILES) as ProfileId[]).filter((id) => {
      const entry = PROFILES[id] as ServProfile;
      return entry.endpoint === "chat" && Boolean(entry.applicationTool) && entry.reasoningEffort !== "none";
    });
    expect(offenders).toEqual([]);
    for (const id of ["report_explain", "agent_explain"] as const) {
      const request = requestFor(id, "facts");
      expect(request.endpoint).toBe("chat");
      if (request.endpoint !== "chat") continue;
      expect(request.reasoning_effort).toBe("none");
      expect(toolNames(request.tools)).toContain("read_computed_facts");
    }
  });

  it("uses every documented feature on at least one profile (Graph excluded — hackathon ban)", () => {
    const used = new Set<string>();
    for (const id of Object.keys(PROFILES) as ProfileId[]) {
      for (const feature of featuresUsedBy(id)) used.add(feature);
    }
    expect([...used].sort()).toEqual([...DOCUMENTED_FEATURES].sort());
    // OpenServ Graph product must not appear (t257/t258). Kronos/Multipath are not Graph.
    expect(used.has("graph")).toBe(false);
    const hints = new Set<string>();
    for (const id of Object.keys(PROFILES) as ProfileId[]) {
      const entry = PROFILES[id] as ServProfile;
      if (!entry.tools.includes("shadow")) continue;
      expect(entry.shadowHint && entry.shadowHint.length).toBeGreaterThan(20);
      expect(entry.shadowMaxIterations).toBeGreaterThanOrEqual(1);
      expect(entry.shadowMaxIterations).toBeLessThanOrEqual(10);
      if (entry.shadowHint) hints.add(entry.shadowHint);
      expect(entry.stream).toBe(false);
      expect(entry.jsonSchema ? entry.feature : "none").not.toBe("kronos");
    }
    expect(hints.size).toBeGreaterThan(1);
    expect(PROFILES.check_rules.feature).toBe("kronos");
    expect((PROFILES.check_rules as ServProfile).jsonSchema).toBeUndefined();
    expect(PROFILES.flip_feasibility.feature).toBe("kronos");
    expect(PROFILES.resale_challenge.feature).toBe("kronos");
    expect(PROFILES.resale_challenge.tools).toEqual(["prompt_guard"]);
    expect(requestFor("resale_challenge", "{}").model).toMatch(/serv-kronos/);
    expect(PROFILES.flip_judge.feature).toBe("multipath");
    expect(PROFILES.flip_judge.jsonSchema?.name).toBe("flip_alert_judgment");
  });

  it("copies inference fields that exist and always builds an agent proof", () => {
    const payload = {
      id: "synthetic-test-1",
      object: "chat.completion",
      model: "gpt-5.4-mini",
      choices: [{ finish_reason: "stop", message: { content: "ALLOW" } }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4, prompt_tokens_details: { cached_tokens: 2 } },
    };
    const copied = openservReportFrom(payload);
    expect(copied).toEqual({
      id: "synthetic-test-1",
      object: "chat.completion",
      model: "gpt-5.4-mini",
      finish_reason: "stop",
      usage: payload.usage,
      choices: [{ finish_reason: "stop", message: { content: "ALLOW" } }],
    });
    expect(copied).not.toHaveProperty("output");
    expect(chatCompletionContent(copied)).toBe("ALLOW");
    const proof = buildServProof({
      purpose: "flip_judge",
      body: requestFor("flip_judge", "{}"),
      payload,
      headers: new Headers(),
      status: 200,
      ok: true,
      text: "{}",
      latencyMs: 12,
      reasoningEffort: "medium",
      codeComputed: ["profitMidUsd"],
    });
    expect(proof.openserv?.usage).toBe(payload.usage);
    expect(proof.features).toEqual(["multipath"]);
    const agent = agentProof([proof], ["priceUsd"]);
    expect(agent.profiles).toHaveLength(1);
    expect(agent.profiles[0]?.suffixes).toEqual(["multipath"]);
    expect(agent.profiles[0]?.promptGuard).toBe("passed");
    expect(agent.codeComputed).toEqual(expect.arrayContaining(["priceUsd", "profitMidUsd"]));
    expect(agent.usage).toBe(payload.usage);
    expect(agent.id).toBe("synthetic-test-1");
    const empty = agentProof([]);
    expect(empty.profiles).toEqual([]);
    expect(Array.isArray(empty.responses)).toBe(true);
  });

  it("makes the writer read calculated figures before the second pass", async () => {
    const bodies: Array<{ messages?: Array<{ role: string; content: string | null }>; tools: Array<{ function?: { name?: string } }>; tool_choice?: { function?: { name?: string } } }> = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length === 1) {
        return Response.json({
          choices: [
            {
              finish_reason: "tool_calls",
              message: { tool_calls: [{ id: "call_1", type: "function", function: { name: "read_computed_facts", arguments: "{}" } }] },
            },
          ],
        });
      }
      return Response.json({
        id: "synthetic-test-2",
        object: "chat.completion",
        model: "gpt-5.4-mini",
        choices: [{ finish_reason: "stop", message: { content: "The fair value is 10000." } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    };
    const result = await runServ("report_explain", { user: "lookup", facts: { fairValueUsd: 10000 } }, { fetch: fetchImpl, apiKey: "test" });
    expect(result.ok).toBe(true);
    expect(bodies[0]?.tool_choice?.function?.name).toBe("read_computed_facts");
    expect((bodies[0] as { reasoning_effort?: string }).reasoning_effort).toBe("none");
    const facts = bodies[0]?.tools.find((tool) => tool.function?.name === "read_computed_facts")?.function as { parameters?: { required?: string[]; properties?: Record<string, unknown> } } | undefined;
    expect(facts?.parameters?.required).toEqual(["seen"]);
    expect(facts?.parameters?.properties?.seen).toBeTruthy();
    expect(bodies[0]?.tools.some((tool) => tool.function?.name === "serv_shadow_agent")).toBe(false);
    expect(bodies[1]?.messages?.some((message) => message.role === "tool" && String(message.content).includes("10000"))).toBe(true);
    expect(bodies[1]?.tools.some((tool) => tool.function?.name === "serv_shadow_agent")).toBe(true);
  });

  it("reads a flat tool call and still explains when the model writes prose instead", async () => {
    expect(
      toolCall({
        choices: [{ message: { tool_calls: [{ name: "read_computed_facts", arguments: { year: 2016 } }] } }],
      })?.name,
    ).toBe("read_computed_facts");
    expect(
      toolCall({
        output: [{ type: "function_call", call_id: "call_r", name: "read_computed_facts", arguments: "{}" }],
      })?.id,
    ).toBe("call_r");

    const bodies: Array<{ messages?: Array<{ role: string; content: string | null }>; tools: Array<{ function?: { name?: string } }> }> = [];
    const prose = await runServ(
      "report_explain",
      { user: "lookup", facts: { fairValueUsd: 10000 } },
      {
        fetch: async (_url, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          if (bodies.length === 1) {
            return Response.json({
              choices: [{ finish_reason: "stop", message: { content: "Here is a writeup with no tool call." } }],
            });
          }
          return Response.json({
            choices: [{ finish_reason: "stop", message: { content: "The fair value is 10000." } }],
          });
        },
        apiKey: "test",
      },
    );
    expect(prose.ok).toBe(true);
    const follow = bodies[1];
    expect(follow?.messages?.some((message) => message.role === "user" && String(message.content).includes("10000"))).toBe(true);
    expect(follow?.messages?.some((message) => message.role === "tool")).toBe(false);
    expect(follow?.tools.some((tool) => tool.function?.name === "serv_shadow_agent")).toBe(true);
  });

  it("puts a proof object on every agent payload", () => {
    const report = agentReport(buildSampleReport("flip"));
    expect(Array.isArray(report.proof.profiles)).toBe(true);
    expect(Array.isArray(report.proof.codeComputed)).toBe(true);
    const scan = radarToolResult([], true, "sample", report.proof);
    expect(scan.proof).toBe(report.proof);
    const unpaid = paymentRequiredBody("https://autoflip.example/api/v1/report");
    expect(unpaid.proof.profiles.length).toBeGreaterThan(0);
    expect(unpaid.proof.codeComputed.length).toBeGreaterThan(0);
  });
});

  it("reads a verdict from a later choice, parsed JSON, or tool arguments", () => {
    expect(messageText({ choices: [{ message: { content: null } }, { message: { content: "{\"decisions\":[]}" } }] })).toBe("{\"decisions\":[]}");
    expect(messageText({ choices: [{ message: { content: null, parsed: { decisions: [{ verdict: "skip" }] } } }] })).toContain("skip");
    expect(
      messageText({
        choices: [{ message: { content: "", tool_calls: [{ function: { name: "judge", arguments: "{\"decisions\":[]}" } }] } }],
      }),
    ).toContain("decisions");
    expect(messageText({ choices: [{ message: { content: null, reasoning: "thinking {\"decisions\":[{\"verdict\":\"alert\"}]}" } }] })).toContain("alert");
    const shape = responseShape({ choices: [{ message: { content: "secret prose", parsed: { decisions: ["hidden"] } } }] });
    expect(shape).toContain("content:string(");
    expect(shape).not.toContain("secret");
    expect(shape).not.toContain("hidden");
  });

  it("reads text parts, ignores a reasoning-only body, and retries one blank answer", async () => {
  expect(messageText({ choices: [{ message: { content: [{ type: "reasoning", text: "hidden" }, { type: "text", text: "Worth a look." }] } }] })).toBe("Worth a look.");
  expect(messageText({ output: [{ type: "output_text", text: "Kept." }] })).toBe("Kept.");
  expect(messageText({ choices: [{ message: { content: null, reasoning: "hidden only" } }] })).toBe("");
  expect(servErrorSummary({ error: { type: "invalid_request_error", message: "Invalid schema. Bearer sk-live-secret" } })).not.toContain("sk-live");

  const logged: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((line) => {
    logged.push(String(line));
  });
  const rejected = await runServ(
    "report_explain",
    { user: "lookup", facts: { fairValueUsd: 1 } },
    {
      apiKey: "sk-test-secret",
      fetch: async () => Response.json({ error: { message: "Invalid schema for function read_computed_facts" } }, { status: 400 }),
    },
  );
  expect(rejected.ok).toBe(false);
  if (rejected.ok) return;
  expect(rejected.upstream).toContain("Invalid schema");
  expect(rejected.upstream).not.toContain("sk-test");
  expect(logged.join(" ")).toContain("HTTP 400");
  spy.mockRestore();

  let calls = 0;
  const recovered = await runServ(
    "flip_judge",
    { user: "{}" },
    {
      apiKey: "test",
      fetch: async () => {
        calls += 1;
        if (calls === 1) return Response.json({ choices: [{ message: { content: "" } }] });
        return Response.json({ choices: [{ message: { content: "{\"decisions\":[]}" } }] });
      },
    },
  );
  expect(recovered.ok).toBe(true);
  expect(calls).toBe(2);
});

it("logs a redacted shape when a 200 is empty, and retries a personal review that misses its first deadline", async () => {
  const logged: string[] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((line) => {
    logged.push(String(line));
  });
  let judgeCalls = 0;
  const empty = await runServ(
    "flip_judge",
    { user: "{}" },
    {
      apiKey: "test",
      fetch: async () => {
        judgeCalls += 1;
        return Response.json({
          id: "synthetic-test-empty",
          choices: [{ finish_reason: "stop", message: { content: null, refusal: null } }],
        });
      },
    },
  );
  expect(empty.ok).toBe(false);
  if (!empty.ok) expect(empty.upstream).toContain("choices:array(");
  expect(logged.join(" ")).toContain("empty");
  expect(logged.join(" ")).not.toMatch(/sk-/);
  expect(judgeCalls).toBe(2);
  spy.mockRestore();

  let reviewCalls = 0;
  const recovered = await runServ(
    "personal_alert_review",
    { user: "alert" },
    {
      apiKey: "test",
      timeoutMs: 3_000,
      fetch: async (_url, init) => {
        reviewCalls += 1;
        if (reviewCalls === 1) {
          await new Promise((_resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("should have aborted")), 5_000);
            init?.signal?.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new DOMException("The operation was aborted.", "TimeoutError"));
            });
          });
        }
        return Response.json({ choices: [{ message: { content: "The price is already in the facts." } }] });
      },
    },
  );
  expect(recovered.ok).toBe(true);
  expect(reviewCalls).toBe(2);
});

function toolNames(tools: ReadonlyArray<{ name?: string; function?: { name?: string } }>): string[] {
  return tools.map((tool) => tool.function?.name || tool.name || "");
}
