import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = resolve(process.cwd(), "src/fonts/orbitron");

const FILES: Record<string, string> = {
  "orbitron-latin-500-normal.woff2":
    "c13360768270c65d6c97701b100a88993885671dfdfd2a400aa58ea0195381ea",
  "orbitron-latin-600-normal.woff2":
    "585062e775d70397653192777533f65f3afb707320fcc2a4bc510470e03762e6",
  "orbitron-latin-700-normal.woff2":
    "ee6acc5ad5349018f9ca71fab8118144160e110838931874150a1ac3f97db38d",
};

describe("vendored Orbitron packaging", () => {
  it("keeps byte hashes, OFL, and Fontsource source pin", () => {
    for (const [name, sha] of Object.entries(FILES)) {
      const buf = readFileSync(resolve(DIR, name));
      expect(createHash("sha256").update(buf).digest("hex")).toBe(sha);
    }
    const ofl = readFileSync(resolve(DIR, "OFL.txt"), "utf8");
    expect(ofl).toMatch(/Orbitron/i);
    expect(ofl).toMatch(/SIL OPEN FONT LICENSE/i);
    const source = readFileSync(resolve(DIR, "SOURCE.md"), "utf8");
    expect(source).toMatch(/fontsource\/fonts\/orbitron@5\.2\.8/);
    expect(source).toMatch(/google\/fonts\/tree\/main\/ofl\/orbitron/);
  });
});
