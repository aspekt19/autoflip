import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DOCUMENTED_FEATURES, featuresUsedBy, PROFILES, type ProfileId } from "./index";

/**
 * Owner t257/t258: OpenServ Graph forbidden for hackathon.
 * Kronos/Multipath ≠ Graph. openGraph meta / mermaid subgraph ≠ Graph.
 */
describe("OpenServ Graph hackathon ban", () => {
  it("does not list graph among documented SERV features", () => {
    expect((DOCUMENTED_FEATURES as readonly string[]).includes("graph")).toBe(false);
  });

  it("no profile reports graph in featuresUsedBy", () => {
    for (const id of Object.keys(PROFILES) as ProfileId[]) {
      expect(featuresUsedBy(id).includes("graph" as never)).toBe(false);
    }
  });

  it("scout + openserv adapter sources do not call OpenServ Graph product APIs", () => {
    const roots = ["src/domain/scout", "src/server/scout", "src/server/openserv"];
    const banned = [
      /@openserv-labs\/graph/i,
      /serv[_-]?graph/i,
      /enableGraph/i,
      /useGraph\s*\(/i,
    ];

    function walk(dir: string, files: string[] = []): string[] {
      for (const name of readdirSync(dir)) {
        const path = resolve(dir, name);
        if (statSync(path).isDirectory()) walk(path, files);
        else if (/\.(ts|tsx)$/.test(name)) files.push(path);
      }
      return files;
    }

    const hits: string[] = [];
    for (const root of roots) {
      for (const file of walk(resolve(process.cwd(), root))) {
        const text = readFileSync(file, "utf8");
        for (const re of banned) {
          if (re.test(text)) hits.push(`${file} ~ ${re}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
