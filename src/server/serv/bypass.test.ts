import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DOCUMENTED_FEATURES, PROFILES, featuresUsedBy, requestFor, runServ, type ProfileId, type ServProfile } from "./index";
import { agentReport } from "@/server/agent-report";
import { buildSampleReport } from "@/server/sample-report";
import { paymentRequiredBody, radarToolResult } from "@/server/mcp";
import { agentProof, buildServProof, openservReportFrom } from "./index";
import { toolCall } from "./run";

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
    const hint = (flip.tools[1]!.function as unknown as { parameters: { properties: { hint: { default: string }; max_iterations: { default: number } } } })
      .parameters.properties;
    expect(hint.hint.default).toMatch(/estimate/i);
    expect(hint.max_iterations.default).toBe(2);
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
    expect(feasibility.endpoint).toBe("chat");
    expect("response_format" in feasibility).toBe(false);
    expect(Object.keys(PROFILES)).toEqual(
      expect.arrayContaining([
        "need_guard",
        "need_extract",
        "check_guard",
        "report_guard",
        "report_explain",
        "agent_guard",
        "agent_explain",
        "radar_guard",
        "personal_alert_review",
        "flip_judge",
        "telegram_reply",
      ]),
    );
  });

  it("uses every documented non-Graph feature on at least one profile", () => {
    const used = new Set<string>();
    for (const id of Object.keys(PROFILES) as ProfileId[]) {
      for (const feature of featuresUsedBy(id)) used.add(feature);
    }
    expect([...used].sort()).toEqual([...DOCUMENTED_FEATURES].sort());
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
    expect(PROFILES.flip_judge.feature).toBe("multipath");
    expect(PROFILES.flip_judge.jsonSchema?.name).toBe("flip_alert_judgment");
  });

  it("copies inference fields that exist and always builds an agent proof", () => {
    const payload = {
      id: "chatcmpl-1",
      object: "chat.completion",
      model: "gpt-5.4-mini",
      choices: [{ finish_reason: "stop", message: { content: "ALLOW" } }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4, prompt_tokens_details: { cached_tokens: 2 } },
    };
    const copied = openservReportFrom(payload);
    expect(copied).toEqual({
      id: "chatcmpl-1",
      object: "chat.completion",
      model: "gpt-5.4-mini",
      finish_reason: "stop",
      usage: payload.usage,
    });
    expect(copied).not.toHaveProperty("output");
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
    expect(agent.id).toBe("chatcmpl-1");
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
        id: "chatcmpl-2",
        object: "chat.completion",
        model: "gpt-5.4-mini",
        choices: [{ finish_reason: "stop", message: { content: "The fair value is 10000." } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    };
    const result = await runServ("report_explain", { user: "lookup", facts: { fairValueUsd: 10000 } }, { fetch: fetchImpl, apiKey: "test" });
    expect(result.ok).toBe(true);
    expect(bodies[0]?.tool_choice?.function?.name).toBe("read_computed_facts");
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

function toolNames(tools: ReadonlyArray<{ name?: string; function?: { name?: string } }>): string[] {
  return tools.map((tool) => tool.function?.name || tool.name || "");
}
