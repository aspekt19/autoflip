/**
 * Prevent Next.js production typegen/build failure from non-Route exports
 * on app/api/scout/route.ts (e.g. postScoutStart).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import * as scoutRoute from "@/app/api/scout/route";
import * as scoutRunRoute from "@/app/api/scout/[runId]/route";

/** Next App Router allowlist for route modules (Route Handler fields). */
const ALLOWED_ROUTE_EXPORTS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "runtime",
  "preferredRegion",
  "dynamic",
  "dynamicParams",
  "revalidate",
  "fetchCache",
  "maxDuration",
  "config",
  "generateStaticParams",
  // Module namespace / vitest interop
  "default",
  "__esModule",
]);

function assertOnlyRouteExports(mod: Record<string, unknown>, label: string) {
  const keys = Object.keys(mod).filter((k) => !k.startsWith("__"));
  const illegal = keys.filter((k) => !ALLOWED_ROUTE_EXPORTS.has(k));
  expect(illegal, `${label} illegal Route exports: ${illegal.join(", ")}`).toEqual([]);
}

describe("Scout Next route export regression", () => {
  it("app/api/scout/route.ts only exports valid Route fields (no postScoutStart)", () => {
    assertOnlyRouteExports(scoutRoute as Record<string, unknown>, "scout/route");
    expect(scoutRoute).toHaveProperty("GET");
    expect(scoutRoute).toHaveProperty("POST");
    expect(scoutRoute).toHaveProperty("runtime");
    expect(scoutRoute).not.toHaveProperty("postScoutStart");
    expect(scoutRoute).not.toHaveProperty("ScoutPostTestHooks");
    // Production POST is unary — hooks are not part of the Route signature.
    expect(scoutRoute.POST.length).toBe(1);
  });

  it("app/api/scout/[runId]/route.ts only exports valid Route fields", () => {
    assertOnlyRouteExports(scoutRunRoute as Record<string, unknown>, "scout/[runId]/route");
    expect(scoutRunRoute).toHaveProperty("GET");
  });

  it("source of scout/route.ts does not export postScoutStart (typegen reads source)", () => {
    const src = readFileSync(join(process.cwd(), "src/app/api/scout/route.ts"), "utf8");
    expect(src).not.toMatch(/export\s+(async\s+)?function\s+postScoutStart/);
    expect(src).not.toMatch(/export\s+(type|const|function|async function|class)\s+ScoutPost/);
    expect(src).toMatch(/export\s+async\s+function\s+POST/);
    expect(src).toMatch(/from\s+"@\/server\/scout\/http-start"/);
  });

  it("no app/api/**/route.ts exports non-allowlisted helpers (scout-adjacent scan)", () => {
    const apiRoot = join(process.cwd(), "src/app/api");
    const routes: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, name.name);
        if (name.isDirectory()) walk(p);
        else if (name.name === "route.ts") routes.push(p);
      }
    };
    walk(apiRoot);
    const scoutRoutes = routes.filter((p) => relative(apiRoot, p).startsWith("scout"));
    expect(scoutRoutes.length).toBeGreaterThanOrEqual(2);
    for (const file of scoutRoutes) {
      const src = readFileSync(file, "utf8");
      const exportFns = [...src.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map((m) => m[1]!);
      const bad = exportFns.filter((n) => !ALLOWED_ROUTE_EXPORTS.has(n));
      expect(bad, `${relative(process.cwd(), file)} bad exports ${bad.join(",")}`).toEqual([]);
    }
  });
});
