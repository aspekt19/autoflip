import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = resolve(process.cwd(), "src/fonts/bebas-neue");

const FILES: Record<string, string> = {
  "bebas-neue-latin-400-normal.woff2":
    "02f5dfc0c21e92f3c724260f035833e627513a1b91230cc490a1ea756c95e5e5",
};

describe("vendored Bebas Neue packaging", () => {
  it("keeps byte hash, OFL, and Fontsource source pin", () => {
    for (const [name, sha] of Object.entries(FILES)) {
      const buf = readFileSync(resolve(DIR, name));
      expect(createHash("sha256").update(buf).digest("hex")).toBe(sha);
    }
    const ofl = readFileSync(resolve(DIR, "OFL.txt"), "utf8");
    expect(ofl).toMatch(/Dharma Type/i);
    expect(ofl).toMatch(/SIL Open Font License/i);
    const source = readFileSync(resolve(DIR, "SOURCE.md"), "utf8");
    expect(source).toMatch(/fontsource\/fonts\/bebas-neue@5\.2\.5/);
    expect(source).toMatch(/google\/fonts\/tree\/main\/ofl\/bebasneue/);
  });
});
