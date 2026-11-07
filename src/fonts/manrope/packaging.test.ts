import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = resolve(process.cwd(), "src/fonts/manrope");

const FILES: Array<{ name: string; sha256: string }> = [
  {
    name: "manrope-latin-400-normal.woff2",
    sha256: "849290ef12a2eeb9af5c11924120d11aa4ae8b435ed3347d7fc8bc240c293ca3",
  },
  {
    name: "manrope-latin-500-normal.woff2",
    sha256: "19874318747181a650eda439c37955220b849d9c4797c9e0718ee67d4bf929bc",
  },
  {
    name: "manrope-latin-600-normal.woff2",
    sha256: "f7ac6258da20ab7541939b59851155753d1d24f1b30cbcb949077a3faa3d1593",
  },
  {
    name: "manrope-latin-700-normal.woff2",
    sha256: "d2a12c85a831e4b5db341767d0347fa3d1361d22a1fcb3e361a16b6c90080f71",
  },
];

describe("vendored Manrope packaging", () => {
  it("ships OFL license + SOURCE attribution beside the exact woff2 files", () => {
    expect(existsSync(resolve(DIR, "OFL.txt"))).toBe(true);
    expect(existsSync(resolve(DIR, "SOURCE.md"))).toBe(true);
    const ofl = readFileSync(resolve(DIR, "OFL.txt"), "utf8");
    expect(ofl).toMatch(/SIL OPEN FONT LICENSE/i);
    expect(ofl).toMatch(/Manrope Project Authors/i);
    const source = readFileSync(resolve(DIR, "SOURCE.md"), "utf8");
    expect(source).toMatch(/fontsource\/fonts\/manrope@5\.2\.8/);
    expect(source).toMatch(/OFL\.txt/);
    expect(source).toMatch(/googlefonts\/manrope/);
  });

  it("keeps the byte-exact latin 400–700 woff2 set documented in SOURCE.md", () => {
    for (const file of FILES) {
      const bytes = readFileSync(resolve(DIR, file.name));
      const digest = createHash("sha256").update(bytes).digest("hex");
      expect(digest).toBe(file.sha256);
    }
  });
});
