/**
 * Offline checks for OpenAI / OpenServ SERV Reasoning structured-output
 * `strict: true` JSON Schema subset (documented provider contract):
 * - every object must set `additionalProperties: false`
 * - every property key must appear in `required`
 * - nested objects (and object branches of unions) obey the same rules
 *
 * Does not call providers. Rejecting schemas here prevents the HTTP 400 seen when
 * `args` was `type: ["object","null"]` without `additionalProperties: false`.
 *
 * Separately, `assertEnumTypeReconciled` catches Anthropic structured-output
 * enum/type conflicts (nullable enums with union `type`) that yield HTTP 400:
 * `Enum value None does not match declared type '['string', 'null']'`.
 */

export type StrictSchemaIssue = { path: string; message: string };

export function assertStrictJsonSchemaSubset(
  schema: unknown,
  path = "$",
): StrictSchemaIssue[] {
  const issues: StrictSchemaIssue[] = [];
  walkStrict(schema, path, issues);
  return issues;
}

/**
 * Anthropic cross-validates every `enum` value against a *single* declared `type`.
 * Union types (e.g. `["string","null"]`) alongside `enum` — including `null` —
 * are rejected before the model runs. Matching scalar `type` + homogeneous enum
 * is fine; enum with no `type` is also accepted. Prefer `anyOf` string-enum +
 * `{type:"null"}` for nullable enums so nullability stays explicit.
 */
export function assertEnumTypeReconciled(
  schema: unknown,
  path = "$",
): StrictSchemaIssue[] {
  const issues: StrictSchemaIssue[] = [];
  walkEnumType(schema, path, issues);
  return issues;
}

function walkStrict(node: unknown, path: string, issues: StrictSchemaIssue[]): void {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  const rec = node as Record<string, unknown>;

  const types = normalizeTypes(rec.type);
  const isObject = types.includes("object") || (types.length === 0 && "properties" in rec);

  if (isObject) {
    if (rec.additionalProperties !== false) {
      issues.push({
        path,
        message: "additionalProperties must be supplied and false on object schemas (strict subset).",
      });
    }
    const props =
      rec.properties && typeof rec.properties === "object" && !Array.isArray(rec.properties)
        ? (rec.properties as Record<string, unknown>)
        : {};
    const required = Array.isArray(rec.required)
      ? rec.required.filter((k): k is string => typeof k === "string")
      : [];
    const propKeys = Object.keys(props);
    for (const key of propKeys) {
      if (!required.includes(key)) {
        issues.push({
          path: `${path}.properties.${key}`,
          message: `Property "${key}" must be listed in required[] under strict mode (use null unions for optionality).`,
        });
      }
      walkStrict(props[key], `${path}.properties.${key}`, issues);
    }
    for (const key of required) {
      if (!propKeys.includes(key)) {
        issues.push({
          path: `${path}.required`,
          message: `required includes "${key}" but properties has no such key.`,
        });
      }
    }
  }

  if (rec.items) walkStrict(rec.items, `${path}.items`, issues);
  if (Array.isArray(rec.anyOf)) {
    rec.anyOf.forEach((branch, i) => walkStrict(branch, `${path}.anyOf[${i}]`, issues));
  }
  if (Array.isArray(rec.oneOf)) {
    rec.oneOf.forEach((branch, i) => walkStrict(branch, `${path}.oneOf[${i}]`, issues));
  }
}

function walkEnumType(node: unknown, path: string, issues: StrictSchemaIssue[]): void {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  const rec = node as Record<string, unknown>;

  if (Array.isArray(rec.enum) && "type" in rec) {
    if (enumConflictsWithDeclaredType(rec.enum, rec.type)) {
      issues.push({
        path,
        message:
          "enum + type conflict (Anthropic structured-output subset): every enum value must match a single declared type — use anyOf[{type:string,enum:[...]},{type:null}] for nullable enums, not type:['string','null'] with null in enum.",
      });
    }
  }

  const props =
    rec.properties && typeof rec.properties === "object" && !Array.isArray(rec.properties)
      ? (rec.properties as Record<string, unknown>)
      : null;
  if (props) {
    for (const [key, child] of Object.entries(props)) {
      walkEnumType(child, `${path}.properties.${key}`, issues);
    }
  }
  if (rec.items) walkEnumType(rec.items, `${path}.items`, issues);
  if (Array.isArray(rec.anyOf)) {
    rec.anyOf.forEach((branch, i) => walkEnumType(branch, `${path}.anyOf[${i}]`, issues));
  }
  if (Array.isArray(rec.oneOf)) {
    rec.oneOf.forEach((branch, i) => walkEnumType(branch, `${path}.oneOf[${i}]`, issues));
  }
}

function enumConflictsWithDeclaredType(enumValues: unknown[], type: unknown): boolean {
  const types = normalizeTypes(type);
  if (types.length === 0) return false;
  // Anthropic rejects union type arrays when an enum is present (even if null is listed).
  if (types.length > 1) return true;
  const only = types[0]!;
  return enumValues.some((value) => !valueMatchesJsonType(value, only));
}

function valueMatchesJsonType(value: unknown, jsonType: string): boolean {
  switch (jsonType) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    default:
      return false;
  }
}

function normalizeTypes(type: unknown): string[] {
  if (typeof type === "string") return [type];
  if (Array.isArray(type)) return type.filter((t): t is string => typeof t === "string");
  return [];
}
