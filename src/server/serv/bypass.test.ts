import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PROFILES, requestFor } from "./index";

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
      if (/postServ\s*\(/.test(text) || text.includes("inference-api.openserv.ai") || text.includes("/chat/completions")) {
        offenders.push(path.relative(process.cwd(), file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("builds the documented tool shape and suffix for each profile", () => {
    const extract = requestFor("need_extract", "family car");
    expect(extract.stream).toBe(false);
    expect(extract.model).toBe("gpt-5.4-mini");
    expect(extract.tools.map((tool) => tool.function.name)).toEqual(["serv_prompt_guard"]);
    expect(extract.response_format?.json_schema.strict).toBe(true);

    const flip = requestFor("flip_judge", "{}");
    expect(flip.model).toBe("gpt-5.4-mini-serv-multipath");
    expect(flip.stream).toBe(false);
    expect(flip.tools.map((tool) => tool.function.name)).toEqual(["serv_prompt_guard", "serv_shadow_agent"]);
    const hint = (flip.tools[1]!.function as unknown as { parameters: { properties: { hint: { default: string }; max_iterations: { default: number } } } })
      .parameters.properties;
    expect(hint.hint.default).toMatch(/estimate/i);
    expect(hint.max_iterations.default).toBe(2);
    const schema = flip.response_format?.json_schema.schema as {
      properties: { decisions: { items: { properties: { verdict: { enum: string[] } } } } };
    };
    expect(schema.properties.decisions.items.properties.verdict.enum).toEqual(["alert", "skip"]);

    for (const id of ["report_explain", "agent_explain", "personal_alert_review", "telegram_reply"] as const) {
      const request = requestFor(id, "facts");
      expect(request.model).not.toMatch(/serv-kronos/);
      expect(request.stream).toBe(false);
      expect(request.tools.map((tool) => tool.function.name)).toContain("serv_shadow_agent");
    }
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
});
