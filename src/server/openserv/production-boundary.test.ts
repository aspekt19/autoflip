/**
 * Enforce that the experimental OpenServ SDK scaffold cannot be mounted into
 * the production app graph without a deliberate, reviewable change.
 *
 * Production Scout integration is SERV Reasoning over HTTP (`src/server/serv`,
 * `src/server/scout/planner`). The SDK Agent file is test/dev-only.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

const FORBIDDEN_IMPORT =
  /(?:from|require\()\s*['"](?:@openserv-labs\/sdk|openai|zod)['"]|from\s*['"]@\/server\/openserv(?:\/|['"])|from\s*['"]\.\.?\/openserv(?:\/scout-agent)?['"]/;

const PRODUCTION_ROOTS = [
  "src/app",
  "src/components",
  "src/domain",
  "src/io",
  "src/server/scout",
  "src/server/serv",
  "src/server/api-keys.ts",
  "src/server/session.ts",
  "src/server/agent-access.ts",
];

function walkFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === ".next") continue;
      walkFiles(full, out);
    } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name) && !name.endsWith(".test.ts") && !name.endsWith(".test.tsx")) {
      out.push(full);
    }
  }
  return out;
}

function collectProductionSources(): string[] {
  const files: string[] = [];
  for (const root of PRODUCTION_ROOTS) {
    const abs = join(ROOT, root);
    try {
      const st = statSync(abs);
      if (st.isFile()) {
        if (!abs.endsWith(".test.ts")) files.push(abs);
      } else {
        walkFiles(abs, files);
      }
    } catch {
      // missing optional path
    }
  }
  return files;
}

describe("production import boundary (experimental OpenServ SDK)", () => {
  it("package.json production dependencies do not list SDK / openai / zod", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const prod = pkg.dependencies ?? {};
    expect(prod["@openserv-labs/sdk"]).toBeUndefined();
    expect(prod.openai).toBeUndefined();
    expect(prod.zod).toBeUndefined();
    // Experimental scaffold stays in devDependencies for tests/typecheck only.
    expect(pkg.devDependencies?.["@openserv-labs/sdk"]).toBeTruthy();
  });

  it("no production source imports @openserv-labs/sdk, openai, zod, or scout-agent", () => {
    const offenders: string[] = [];
    for (const file of collectProductionSources()) {
      const text = readFileSync(file, "utf8");
      if (FORBIDDEN_IMPORT.test(text)) {
        offenders.push(relative(ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("scout-agent remains labeled experimental / unmounted", () => {
    const src = readFileSync(join(ROOT, "src/server/openserv/scout-agent.ts"), "utf8");
    expect(src).toMatch(/EXPERIMENTAL\s*\/\s*UNMOUNTED/i);
    expect(src).toMatch(/devDependencies/i);
    expect(src).toMatch(/Not production integration/i);
  });

  it("SERV HTTP planner path does not reference the SDK package", () => {
    const planner = readFileSync(join(ROOT, "src/server/scout/planner.ts"), "utf8");
    expect(planner).toMatch(/runServ/);
    expect(planner).not.toMatch(/from ["']@openserv-labs\/sdk["']/);
    expect(planner).toMatch(/Do not use @openserv-labs\/sdk Agent\.process/);
  });
});
