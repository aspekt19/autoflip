import { describe, expect, it } from "vitest";
import { PROFILES } from "./profiles";
import { requestFor } from "./run";
import { assertEnumTypeReconciled, assertStrictJsonSchemaSubset } from "./strict-json-schema";
import { SCOUT_PLAN_JSON_SCHEMA } from "@/server/scout/serv-options";

/** Sonnet-class request fault: nullable enum with union type (null appears as Python None). */
const SONNET_NULLABLE_ENUM_UNION = {
  type: ["string", "null"] as ["string", "null"],
  enum: [null, "adverse_evidence", "uncertainty_progress"],
};

describe("scout_plan strict JSON schema subset (offline)", () => {
  it("live profile schema satisfies documented strict subset (args.additionalProperties false)", () => {
    const schema = PROFILES.scout_plan.jsonSchema?.schema;
    expect(schema).toBeTruthy();
    const issues = assertStrictJsonSchemaSubset(schema);
    expect(issues).toEqual([]);

    const root = schema as {
      properties: {
        args: Record<string, unknown>;
        reason: { type?: string; pattern?: string };
        servStepId?: unknown;
        toolId: Record<string, unknown>;
        rationaleKind: Record<string, unknown>;
      };
      required: string[];
    };
    const props = root.properties;
    expect(props.args.additionalProperties).toBe(false);
    expect(props.args.type).toEqual(["object", "null"]);
    expect(Array.isArray(props.args.required) && (props.args.required as string[]).includes("maxPriceUsd")).toBe(
      true,
    );
    // Request schema: nonempty reason is runtime (plan-parse), not pattern.
    // servStepId is execution-owned — not a model schema field.
    expect(props.reason).toEqual({ type: "string" });
    expect(props.reason.pattern).toBeUndefined();
    expect(props.servStepId).toBeUndefined();
    expect(root.required).not.toContain("servStepId");
    expect(root.required).toContain("reason");
  });

  it("serv-options twin matches live profile and is also strict-clean", () => {
    expect(SCOUT_PLAN_JSON_SCHEMA.name).toBe(PROFILES.scout_plan.jsonSchema?.name);
    expect(assertStrictJsonSchemaSubset(SCOUT_PLAN_JSON_SCHEMA.schema)).toEqual([]);
    expect(JSON.stringify(SCOUT_PLAN_JSON_SCHEMA.schema)).toBe(
      JSON.stringify(PROFILES.scout_plan.jsonSchema?.schema),
    );
  });

  it("serialized requestFor(scout_plan) response_format embeds strict-clean schema", () => {
    const req = requestFor("scout_plan", JSON.stringify({ pendingVins: [] }), undefined, {});
    const rf = (req as { response_format?: { type: string; json_schema?: { strict?: boolean; schema?: unknown } } })
      .response_format;
    expect(rf?.type).toBe("json_schema");
    expect(rf?.json_schema?.strict).toBe(true);
    expect(assertStrictJsonSchemaSubset(rf?.json_schema?.schema)).toEqual([]);

    const serialized = JSON.stringify(req);
    expect(serialized).toContain('"additionalProperties":false');
    expect(serialized).toContain('"name":"lemonless_scout_plan_action"');
    // Execution-owned correlation must not appear in model request schema.
    expect(serialized).not.toContain('"servStepId"');
    // Regression of production 400: object args without additionalProperties:false.
    expect(serialized).not.toMatch(
      /"args":\{"type":\["object","null"\]\}/,
    );
    const parsed = JSON.parse(serialized) as {
      response_format: { json_schema: { schema: { properties: { args: { additionalProperties: unknown } } } } };
    };
    expect(parsed.response_format.json_schema.schema.properties.args.additionalProperties).toBe(false);
  });

  it("rejects the pre-fix open-object args shape that caused SERV HTTP 400", () => {
    const broken = {
      type: "object",
      additionalProperties: false,
      required: ["type", "args"],
      properties: {
        type: { type: "string" },
        args: { type: ["object", "null"] },
      },
    };
    const issues = assertStrictJsonSchemaSubset(broken);
    expect(issues.some((i) => i.path.includes("args") && /additionalProperties/i.test(i.message))).toBe(
      true,
    );
  });
});

describe("scout_plan Anthropic enum/type reconciliation (offline; Sonnet HTTP 400 class)", () => {
  it("failure-first: union type + null-in-enum matches sanitizedUpstream diagnostic class", () => {
    const issues = assertEnumTypeReconciled({
      type: "object",
      additionalProperties: false,
      required: ["rationaleKind"],
      properties: { rationaleKind: SONNET_NULLABLE_ENUM_UNION },
    });
    expect(issues.some((i) => i.path.includes("rationaleKind") && /enum \+ type conflict/i.test(i.message))).toBe(
      true,
    );
  });

  it("accepts anyOf string-enum + null (nullable semantics without union type)", () => {
    const fixed = {
      anyOf: [
        { type: "string", enum: ["adverse_evidence", "uncertainty_progress"] },
        { type: "null" },
      ],
    };
    expect(assertEnumTypeReconciled(fixed)).toEqual([]);
  });

  it("accepts matching scalar type + homogeneous string enum; rejects null-in-enum under type string", () => {
    expect(
      assertEnumTypeReconciled({ type: "string", enum: ["select_candidate", "abstain"] }),
    ).toEqual([]);
    expect(
      assertEnumTypeReconciled({ type: "string", enum: [null, "adverse_evidence"] }).length,
    ).toBeGreaterThan(0);
  });

  it("live scout_plan toolId + rationaleKind are enum/type reconciled (nullability via anyOf)", () => {
    const schema = PROFILES.scout_plan.jsonSchema?.schema;
    expect(schema).toBeTruthy();
    expect(assertEnumTypeReconciled(schema)).toEqual([]);

    const props = (schema as {
      properties: { toolId: Record<string, unknown>; rationaleKind: Record<string, unknown> };
    }).properties;

    for (const key of ["toolId", "rationaleKind"] as const) {
      const field = props[key];
      expect(field).toBeTruthy();
      expect(field.type).toBeUndefined();
      expect(Array.isArray(field.anyOf)).toBe(true);
      const branches = field.anyOf as Array<Record<string, unknown>>;
      expect(branches.some((b) => b.type === "null")).toBe(true);
      const stringBranch = branches.find((b) => b.type === "string");
      expect(stringBranch).toBeTruthy();
      expect(Array.isArray(stringBranch!.enum)).toBe(true);
      expect((stringBranch!.enum as unknown[]).includes(null)).toBe(false);
    }
  });

  it("serialized requestFor(scout_plan) has no type:['string','null'] + enum null pairs", () => {
    const req = requestFor("scout_plan", JSON.stringify({ pendingVins: [] }), undefined, {});
    const schema = (
      req as { response_format: { json_schema: { schema: unknown } } }
    ).response_format.json_schema.schema;
    expect(assertEnumTypeReconciled(schema)).toEqual([]);
    expect(assertStrictJsonSchemaSubset(schema)).toEqual([]);

    const serialized = JSON.stringify(req);
    // Pre-fix Sonnet fault shape must not appear for nullable enum fields.
    expect(serialized).not.toMatch(
      /"type":\["string","null"\],"enum":\[null/,
    );
    expect(serialized).not.toMatch(
      /"enum":\[null[^\]]*\],"type":\["string","null"\]/,
    );
  });

  it("serv-options twin stays enum/type reconciled and byte-identical to live profile", () => {
    expect(assertEnumTypeReconciled(SCOUT_PLAN_JSON_SCHEMA.schema)).toEqual([]);
    expect(JSON.stringify(SCOUT_PLAN_JSON_SCHEMA.schema)).toBe(
      JSON.stringify(PROFILES.scout_plan.jsonSchema?.schema),
    );
  });
});

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
        if (/"default"\s*:/.test(serialized)) {
          failures.push(`${id} tool ${tool.name}: parameters must not include default (strict subset)`);
        }
        for (const issue of assertStrictJsonSchemaSubset(tool.parameters)) {
          failures.push(`${id} tool ${tool.name} ${issue.path}: ${issue.message}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("verdict_decide keeps prompt_guard + shadow; shadow uses documented default form", () => {
    const req = requestFor("verdict_decide", JSON.stringify({ facts: {} }), undefined, {});
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
