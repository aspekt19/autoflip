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
