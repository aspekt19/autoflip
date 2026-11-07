import { describe, expect, it } from "vitest";
import { PROFILES } from "./profiles";
import { requestFor } from "./run";
import { assertStrictJsonSchemaSubset } from "./strict-json-schema";
import { SCOUT_PLAN_JSON_SCHEMA } from "@/server/scout/serv-options";

describe("scout_plan strict JSON schema subset (offline)", () => {
  it("live profile schema satisfies documented strict subset (args.additionalProperties false)", () => {
    const schema = PROFILES.scout_plan.jsonSchema?.schema;
    expect(schema).toBeTruthy();
    const issues = assertStrictJsonSchemaSubset(schema);
    expect(issues).toEqual([]);

    const props = (schema as {
      properties: {
        args: Record<string, unknown>;
        reason: { type?: string; pattern?: string };
        servStepId: { type?: string; pattern?: string };
      };
    }).properties;
    expect(props.args.additionalProperties).toBe(false);
    expect(props.args.type).toEqual(["object", "null"]);
    expect(Array.isArray(props.args.required) && (props.args.required as string[]).includes("maxPriceUsd")).toBe(
      true,
    );
    // Request schema stays plain string — nonempty is runtime (plan-parse), not pattern.
    expect(props.reason).toEqual({ type: "string" });
    expect(props.servStepId).toEqual({ type: "string" });
    expect(props.reason.pattern).toBeUndefined();
    expect(props.servStepId.pattern).toBeUndefined();
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
