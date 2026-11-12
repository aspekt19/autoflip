/**
 * Enforce that the experimental OpenServ SDK scaffold cannot be mounted into
 * the production app graph without a deliberate, reviewable change.
 *
 * Scans all of `src/` except tests and the explicit allowlisted scaffold.
 * Detects static/dynamic import/require. Negative cases prove fail-closed
 * (missing root / empty / read failure / forbidden dynamic import → not OK).
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const boundaryUrl = pathToFileURL(join(ROOT, "scripts/openserv-boundary.mjs")).href;

async function loadBoundary() {
  return import(boundaryUrl);
}

describe("production import boundary (experimental OpenServ SDK)", () => {
  it("package.json production dependencies do not list SDK / openai / zod", async () => {
    const { readFileSync } = await import("node:fs");
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const prod = pkg.dependencies ?? {};
    expect(prod["@openserv-labs/sdk"]).toBeUndefined();
    expect(prod.openai).toBeUndefined();
    expect(prod.zod).toBeUndefined();
    expect(pkg.devDependencies?.["@openserv-labs/sdk"]).toBeTruthy();
  });

  it("scans all production src (incl. mcp/assemble/deps/stripe) with zero forbidden imports", async () => {
    const { scanProductionSources, ALLOWED_SOURCE_REL_PATHS } = await loadBoundary();
    const result = scanProductionSources(ROOT);
    expect(result.filesScanned).toBeGreaterThan(50);
    expect(result.allowed).toEqual([...ALLOWED_SOURCE_REL_PATHS]);
    expect(result.ok).toBe(true);
    expect(result.offenders).toEqual([]);

    // Smoke: known production modules are inside the scanned universe.
    const { collectProductionSourceFiles } = await loadBoundary();
    const { scanned } = collectProductionSourceFiles(ROOT);
    const rels = scanned.map((abs: string) => abs.replace(/\\/g, "/"));
    expect(rels.some((r: string) => r.endsWith("/src/server/mcp.ts"))).toBe(true);
    expect(rels.some((r: string) => r.endsWith("/src/server/assemble.ts"))).toBe(true);
    expect(rels.some((r: string) => r.endsWith("/src/server/deps.ts"))).toBe(true);
    expect(rels.some((r: string) => r.endsWith("/src/server/stripe.ts"))).toBe(true);
  });

  it("detects static, dynamic await import, and require of forbidden packages", async () => {
    const { findForbiddenImportHits } = await loadBoundary();
    const samples: Array<{ label: string; src: string; kind: string }> = [
      {
        label: "static from sdk",
        src: `import { Agent } from "@openserv-labs/sdk";\n`,
        kind: "static_from",
      },
      {
        label: "dynamic await import openai",
        src: `export async function load() {\n  return await import("openai");\n}\n`,
        kind: "dynamic_import",
      },
      {
        label: "require zod",
        src: `const z = require("zod");\n`,
        kind: "require",
      },
      {
        label: "alias openserv",
        src: `import { build } from "@/server/openserv/scout-agent";\n`,
        kind: "alias_openserv",
      },
      {
        label: "relative openserv",
        src: `import { build } from "../openserv/scout-agent";\n`,
        kind: "relative_openserv",
      },
      {
        label: "dynamic import sdk",
        src: `const m = await import('@openserv-labs/sdk');\n`,
        kind: "dynamic_import",
      },
    ];
    for (const sample of samples) {
      const hits = findForbiddenImportHits(sample.src);
      expect(hits.length, sample.label).toBeGreaterThan(0);
      expect(
        hits.some((h: { kind: string }) => h.kind === sample.kind),
        `${sample.label} kind`,
      ).toBe(true);
    }
  });

  it("does not false-positive on comment mentioning the SDK package name", async () => {
    const { findForbiddenImportHits } = await loadBoundary();
    const src = `// Do not use @openserv-labs/sdk Agent.process() — that hardcodes OpenAI.\nexport const x = 1;\n`;
    expect(findForbiddenImportHits(src)).toEqual([]);
  });

  it("fail-closed: missing scan root does not report OK", async () => {
    const { scanProductionSources, scanNextServerForOpenServ, assertScanOk } =
      await loadBoundary();
    const missing = join(ROOT, "this-path-does-not-exist-" + Date.now());
    expect(() => scanProductionSources(missing)).toThrow(/missing|ENOENT|scan root/i);
    expect(() => scanNextServerForOpenServ(ROOT, missing)).toThrow(/missing|ENOENT|scan root/i);
    expect(() => assertScanOk({ ok: true, filesScanned: 0, offenders: [] }, "t")).toThrow(
      /incomplete|fail closed/i,
    );
    expect(() =>
      assertScanOk(
        { ok: false, filesScanned: 3, offenders: [{ file: "x.ts", hits: [] }] },
        "t",
      ),
    ).toThrow(/forbidden/i);
  });

  it("fail-closed: forbidden dynamic import in a temp production tree is detected (no false OK)", async () => {
    const { scanProductionSources } = await loadBoundary();
    const tmp = mkdtempSync(join(tmpdir(), "openserv-boundary-"));
    try {
      const srcDir = join(tmp, "src", "server");
      mkdirSync(srcDir, { recursive: true });
      // Offending production file (mcp-like) with dynamic import.
      writeFileSync(
        join(srcDir, "mcp.ts"),
        `export async function boot() {\n  return await import("@openserv-labs/sdk");\n}\n`,
        "utf8",
      );
      const result = scanProductionSources(tmp);
      expect(result.ok).toBe(false);
      expect(result.offenders.length).toBeGreaterThan(0);
      expect(result.offenders[0].file).toMatch(/mcp\.ts$/);
      expect(
        result.offenders[0].hits.some((h: { kind: string }) => h.kind === "dynamic_import"),
      ).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fail-closed: .next/server missing or containing SDK marker is not OK", async () => {
    const { scanNextServerForOpenServ, assertScanOk } = await loadBoundary();
    const tmp = mkdtempSync(join(tmpdir(), "openserv-next-"));
    try {
      expect(() => scanNextServerForOpenServ(tmp, join(tmp, ".next", "server"))).toThrow(
        /missing|scan root/i,
      );

      const serverDir = join(tmp, ".next", "server");
      mkdirSync(serverDir, { recursive: true });
      writeFileSync(join(serverDir, "chunk.js"), `/* @openserv-labs/sdk embedded */\n`, "utf8");
      const dirty = scanNextServerForOpenServ(tmp, serverDir);
      expect(dirty.ok).toBe(false);
      expect(() => assertScanOk(dirty, "next")).toThrow(/forbidden/i);

      writeFileSync(join(serverDir, "chunk.js"), `/* clean chunk */\n`, "utf8");
      const clean = scanNextServerForOpenServ(tmp, serverDir);
      expect(clean.ok).toBe(true);
      expect(clean.filesScanned).toBeGreaterThan(0);
      assertScanOk(clean, "next-clean");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
