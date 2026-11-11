import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = resolve(process.cwd(), "src/fonts/jetbrains-mono");

const FILES: Array<{ name: string; sha256: string }> = [
  {
    name: "jetbrains-mono-latin-400-normal.woff2",
    sha256: "14425ba9c695763c1547f48a206b7aa60350a33ae23de09f0407877f3fcd89eb",
  },
  {
    name: "jetbrains-mono-latin-500-normal.woff2",
    sha256: "cb182feeed4d798ff6961d3c79f7026279448fca0676438aaecb21f3fc39553a",
  },
  {
    name: "jetbrains-mono-latin-600-normal.woff2",
    sha256: "400c6bfda18d5d14acad1c15d6dcb9f8e13c015e7286317e0b9a482539bef147",
  },
  {
    name: "jetbrains-mono-latin-700-normal.woff2",
    sha256: "d0d4e818808f2a0ba39b2b09d1989366f63494e295f003c7ef436697378507e8",
  },
];

describe("vendored JetBrains Mono packaging", () => {
  it("ships OFL license + SOURCE attribution beside the exact woff2 files", () => {
    expect(existsSync(resolve(DIR, "OFL.txt"))).toBe(true);
    expect(existsSync(resolve(DIR, "SOURCE.md"))).toBe(true);
    const ofl = readFileSync(resolve(DIR, "OFL.txt"), "utf8");
    expect(ofl).toMatch(/SIL OPEN FONT LICENSE/i);
    expect(ofl).toMatch(/JetBrains Mono Project Authors/i);
    const source = readFileSync(resolve(DIR, "SOURCE.md"), "utf8");
    expect(source).toMatch(/fontsource\/fonts\/jetbrains-mono@5\.2\.8/);
    expect(source).toMatch(/OFL\.txt/);
    expect(source).toMatch(/JetBrains\/JetBrainsMono/);
  });

  it("keeps the byte-exact latin 400–700 woff2 set documented in SOURCE.md", () => {
    for (const file of FILES) {
      const bytes = readFileSync(resolve(DIR, file.name));
      const digest = createHash("sha256").update(bytes).digest("hex");
      expect(digest).toBe(file.sha256);
    }
  });
});
