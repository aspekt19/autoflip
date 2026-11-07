/**
 * Offline checks for OpenAI / OpenServ SERV Reasoning structured-output
 * `strict: true` JSON Schema subset (documented provider contract):
 * - every object must set `additionalProperties: false`
 * - every property key must appear in `required`
 * - nested objects (and object branches of unions) obey the same rules
 *
 * Does not call providers. Rejecting schemas here prevents the HTTP 400 seen when
 * `args` was `type: ["object","null"]` without `additionalProperties: false`.
 */

export type StrictSchemaIssue = { path: string; message: string };

export function assertStrictJsonSchemaSubset(
  schema: unknown,
  path = "$",
): StrictSchemaIssue[] {
  const issues: StrictSchemaIssue[] = [];
  walk(schema, path, issues);
  return issues;
}

function walk(node: unknown, path: string, issues: StrictSchemaIssue[]): void {
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
      walk(props[key], `${path}.properties.${key}`, issues);
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

  if (rec.items) walk(rec.items, `${path}.items`, issues);
  if (Array.isArray(rec.anyOf)) {
    rec.anyOf.forEach((branch, i) => walk(branch, `${path}.anyOf[${i}]`, issues));
  }
  if (Array.isArray(rec.oneOf)) {
    rec.oneOf.forEach((branch, i) => walk(branch, `${path}.oneOf[${i}]`, issues));
  }
}

function normalizeTypes(type: unknown): string[] {
  if (typeof type === "string") return [type];
  if (Array.isArray(type)) return type.filter((t): t is string => typeof t === "string");
  return [];
}
