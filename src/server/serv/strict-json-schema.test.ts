import { describe, expect, it } from "vitest";
import { BASE_MODEL, PROFILES } from "./profiles";
import { requestFor } from "./run";
import { assertEnumTypeReconciled, assertStrictJsonSchemaSubset } from "./strict-json-schema";

/** Sonnet-class request fault: nullable enum with union type (null appears as Python None). */
const SONNET_NULLABLE_ENUM_UNION = {
  type: ["string", "null"] as ["string", "null"],
  enum: [null, "adverse_evidence", "uncertainty_progress"],
};

function toolParameterSchemas(req: unknown): Array<{ name: string; parameters: unknown }> {
  const tools = (req as { tools?: Array<{ name?: string; function?: { name?: string; parameters?: unknown }; parameters?: unknown }> })
    .tools;
  if (!Array.isArray(tools)) return [];
  return tools.map((tool) => ({
    name: tool.function?.name || tool.name || "unknown",
    parameters: tool.function?.parameters ?? tool.parameters ?? null,
  }));
}

describe("every SERV requestFor payload is strict-schema clean (tools + response_format)", () => {
  const profileIds = Object.keys(PROFILES) as Array<keyof typeof PROFILES>;

  it("validates response_format schemas and every tool parameters object for all profiles", () => {
    const failures: string[] = [];
    for (const id of profileIds) {
      let req: unknown;
      try {
        req = requestFor(id, "{}", undefined, {});
      } catch (err) {
        // Some profiles require env token bounds — skip with a clear note only if throw is expected.
        failures.push(`${id}: requestFor threw ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const rf = (req as { response_format?: { json_schema?: { schema?: unknown; strict?: boolean } } })
        .response_format;
      if (rf?.json_schema?.schema) {
        expect(rf.json_schema.strict).toBe(true);
        for (const issue of assertStrictJsonSchemaSubset(rf.json_schema.schema)) {
          failures.push(`${id} response_format ${issue.path}: ${issue.message}`);
        }
        for (const issue of assertEnumTypeReconciled(rf.json_schema.schema)) {
          failures.push(`${id} response_format enum ${issue.path}: ${issue.message}`);
        }
      }
      for (const tool of toolParameterSchemas(req)) {
        if (tool.parameters == null) {
          failures.push(`${id} tool ${tool.name}: missing parameters object (strict response_format incompatible)`);
          continue;
        }
        // serv_shadow_agent is a SERV Tools marker consumed before the model.
        // OpenServ docs pin hint / max_iterations via JSON Schema `default` (not enums).
        // https://docs.openserv.ai/serv-reasoning/tutorials/shadow-agent
        if (tool.name === "serv_shadow_agent") {
          const params = tool.parameters as {
            properties?: { hint?: { default?: unknown }; max_iterations?: { default?: unknown } };
          };
          if (typeof params.properties?.hint?.default !== "string") {
            failures.push(`${id} tool serv_shadow_agent: hint.default must be a string (OpenServ docs)`);
          }
          if (typeof params.properties?.max_iterations?.default !== "number") {
            failures.push(
              `${id} tool serv_shadow_agent: max_iterations.default must be a number (OpenServ docs)`,
            );
          }
          if (/"enum"\s*:/.test(JSON.stringify(tool.parameters))) {
            failures.push(`${id} tool serv_shadow_agent: must not pin hint/max_iterations via enum`);
          }
          continue;
        }
        // Application / other tool params stay on the strict subset (no `default`).
        const serialized = JSON.stringify(tool.parameters);
        // Shadow Agent uses the documented `default` form. Other tools stay default-free.
        if (tool.name === "serv_shadow_agent") {
          if (!/"default"\s*:/.test(serialized)) {
            failures.push(`${id} tool serv_shadow_agent: documented form requires JSON Schema default`);
          }
          if (/"enum"\s*:/.test(serialized)) {
            failures.push(`${id} tool serv_shadow_agent: must not use enum to pin shadow settings`);
          }
        } else if (/"default"\s*:/.test(serialized)) {
          failures.push(`${id} tool ${tool.name}: parameters must not include default (strict subset)`);
        }
        for (const issue of assertStrictJsonSchemaSubset(tool.parameters)) {
          failures.push(`${id} tool ${tool.name} ${issue.path}: ${issue.message}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("verdict_decide is bare BASE_MODEL with a strict schema and no prompt-guard tools", () => {
    const req = requestFor("verdict_decide", JSON.stringify({ facts: {} }), undefined, {});
    expect(req.model).toBe(BASE_MODEL);
    expect(toolParameterSchemas(req).map((tool) => tool.name)).toEqual([]);
    const rf = (req as { response_format: { json_schema: { strict: boolean; schema: unknown } } }).response_format;
    expect(rf.json_schema.strict).toBe(true);
    expect(assertStrictJsonSchemaSubset(rf.json_schema.schema)).toEqual([]);
  });

  it("flip_judge shadow uses the documented default form", () => {
    const req = requestFor("flip_judge", JSON.stringify({ facts: {} }), undefined, {});
    const tools = toolParameterSchemas(req);
    expect(tools.map((t) => t.name).sort()).toEqual(["serv_prompt_guard", "serv_shadow_agent"].sort());
    const guard = tools.find((t) => t.name === "serv_prompt_guard");
    const shadow = tools.find((t) => t.name === "serv_shadow_agent");
    expect(guard).toBeTruthy();
    expect(shadow).toBeTruthy();
    expect(assertStrictJsonSchemaSubset(guard!.parameters)).toEqual([]);
    expect(JSON.stringify(guard!.parameters)).not.toMatch(/"default"\s*:/);
    const shadowParams = shadow!.parameters as {
      properties: { hint: { default: string }; max_iterations: { default: number } };
    };
    expect(typeof shadowParams.properties.hint.default).toBe("string");
    expect(typeof shadowParams.properties.max_iterations.default).toBe("number");
    expect(JSON.stringify(shadow!.parameters)).not.toMatch(/"enum"\s*:/);
    const rf = (req as { response_format: { json_schema: { strict: boolean; schema: unknown } } })
      .response_format;
    expect(rf.json_schema.strict).toBe(true);
    expect(assertStrictJsonSchemaSubset(rf.json_schema.schema)).toEqual([]);
  });
});
