/**
 * Enforcement: code must never mint SearchSpec / UserIntent constraints by
 * regex-parsing the shopper note. SERV interprets free text; typed form fields
 * (`origin: "user"`) are the only non-SERV source.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { groundedNumberTokens, validateFindPlan, wordAmountTokens } from "./find-plan";
import { buildSearchSpec } from "./search-spec";
import { buildUserIntent, serializeUserIntentConstraints } from "./serv-boundary";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

const R3_NOTE = "UNDER THIRTY FIVE THOUSAND. 2019 OR NEWER";

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === ".next") continue;
      walkTsFiles(abs, out);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(name)) continue;
    if (/\.test\.(ts|tsx)$/.test(name)) continue;
    out.push(abs);
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
}

describe("note→constraint enforcement — SearchSpec / UserIntent", () => {
  it("never mints hard price/year from the r3 word-budget + year note alone", () => {
    const spec = buildSearchSpec({ note: R3_NOTE });
    expect(spec.hard.priceMaxUsd).toBeUndefined();
    expect(spec.hard.yearMin).toBeUndefined();
    expect(spec.hard.yearMax).toBeUndefined();
    expect(spec.hard.milesMax).toBeUndefined();
    expect(spec.hard.zip).toBeUndefined();
    expect(spec.hard.bodyStyles).toBeUndefined();
    expect(spec.hard.drivetrain).toBeUndefined();

    const intent = buildUserIntent({ note: R3_NOTE });
    expect(intent.fields).toEqual({});
    expect(serializeUserIntentConstraints(intent)).toEqual({});
  });

  it("keeps SERV budget 35000 (and yearMin 2019) when form is empty", () => {
    const spec = buildSearchSpec({
      note: R3_NOTE,
      servPlan: {
        priceMaxUsd: 35_000,
        priceQuote: "UNDER THIRTY FIVE THOUSAND",
        yearMin: 2019,
        yearQuote: "2019 OR NEWER",
        bodyStyles: ["SUV"],
      },
    });
    expect(spec.hard.priceMaxUsd).toEqual({
      value: 35_000,
      source: "serv",
      quote: "UNDER THIRTY FIVE THOUSAND",
    });
    expect(spec.hard.yearMin).toEqual({
      value: 2019,
      source: "serv",
      quote: "2019 OR NEWER",
    });
    // Never a $2019 hard price from the year token.
    expect(spec.hard.priceMaxUsd?.value).not.toBe(2019);
  });

  it("user-origin form remains the only non-SERV constraint source", () => {
    const spec = buildSearchSpec({
      note: R3_NOTE,
      formEdits: {
        priceMaxUsd: { value: 40_000, origin: "user" },
        yearMin: { value: 2020, origin: "user" },
      },
      servPlan: { priceMaxUsd: 35_000, yearMin: 2019 },
    });
    expect(spec.hard.priceMaxUsd).toEqual({ value: 40_000, source: "form" });
    expect(spec.hard.yearMin).toEqual({ value: 2020, source: "form" });
  });

  it("grounding accepts word budgets so SERV 35000 is not dropped", () => {
    expect(wordAmountTokens(R3_NOTE)).toContain(35_000);
    const tokens = groundedNumberTokens(R3_NOTE);
    expect(tokens.has("35000")).toBe(true);
    // Year digits are tokens for year grounding, but must not be the only budget path.
    expect(tokens.has("2019")).toBe(true);

    const validated = validateFindPlan(
      {
        summary: "SUV under thirty five thousand, 2019 or newer",
        bodyStyles: ["suv"],
        budget: { maxUsd: 35_000, approximate: false, quote: "UNDER THIRTY FIVE THOUSAND" },
        yearMin: 2019,
        yearMax: null,
        milesMax: null,
        drivetrain: { value: "any", strength: "none", quote: null },
        fuel: { value: "any", strength: "none", quote: null },
        seatsMin: null,
        location: { zip: null, phrase: null, needsZip: false },
        priorities: [],
        namedModels: [],
        excludedMakes: [],
        question: { id: "none", text: null },
        directions: [
          {
            label: "Compact SUVs",
            why: "Fits the budget and year floor.",
            bodyStyle: "suv",
            models: [{ make: "Toyota", model: "RAV4" }],
          },
        ],
      },
      { note: R3_NOTE },
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.plan.budget.maxUsd).toBe(35_000);
    expect(validated.plan.yearMin).toBe(2019);
    expect(validated.dropped).not.toContain("budget.maxUsd");
  });
});

describe("note→constraint enforcement — production builders must not call note parsers", () => {
  it("buildSearchSpec / buildUserIntent source files do not import note constraint parsers", () => {
    const searchSpec = readFileSync(join(SRC, "domain/search-spec.ts"), "utf8");
    const userIntent = readFileSync(join(SRC, "domain/serv-boundary.ts"), "utf8");
    const searchBody = stripComments(searchSpec);
    const intentBody = stripComments(userIntent);

    for (const forbidden of [
      "budgetFromText",
      "yearsFromNote",
      "milesFromText",
      "milesCapFromNote",
      "zipFromNote",
      "bodyFromIntake",
      "historyFromText",
      "awdLimitFromText",
      "intakeFromNote",
      "excludedMakesFromNote",
      "newerThanExclusive",
    ]) {
      expect(searchBody, `search-spec still references ${forbidden}`).not.toMatch(
        new RegExp(`\\b${forbidden}\\b`),
      );
    }
    for (const forbidden of [
      "budgetFromText",
      "yearsFromNote",
      "milesFromText",
      "zipFromNote",
      "bodyFromIntake",
      "awdLimitFromText",
    ]) {
      expect(intentBody, `serv-boundary still references ${forbidden}`).not.toMatch(
        new RegExp(`\\b${forbidden}\\b`),
      );
    }
  });

  it("buildSearchSpec never assigns source:\"note\" in production code", () => {
    const text = stripComments(readFileSync(join(SRC, "domain/search-spec.ts"), "utf8"));
    expect(text).not.toMatch(/source:\s*["']note["']/);
  });

  it("find-match does not re-parse the note for hard AWD", () => {
    const text = stripComments(readFileSync(join(SRC, "server/find-match.ts"), "utf8"));
    expect(text).not.toMatch(/\bawdLimitFromText\b/);
  });

  it("find-plan grounding does not call budgetFromText or invent body/fuel from note", () => {
    const text = stripComments(readFileSync(join(SRC, "domain/find-plan.ts"), "utf8"));
    expect(text).not.toMatch(/\bbudgetFromText\b/);
    expect(text).not.toMatch(/\bnoteImpliedBodyStyle\b/);
    expect(text).not.toMatch(/\bnoteImpliesEv\b/);
  });

  it("no production path stamps origin:\"note\" via note parsers in constraint builders", () => {
    // Spot-check: buildUserIntent file has no noteField helper anymore.
    const text = readFileSync(join(SRC, "domain/serv-boundary.ts"), "utf8");
    expect(text).not.toMatch(/function noteField/);
    expect(stripComments(text)).not.toMatch(/provenance:\s*["']note["']/);
  });

  it("walk: search-spec + serv-boundary stay free of note-intake constraint imports", () => {
    const files = walkTsFiles(SRC)
      .map((abs) => ({ path: relative(ROOT, abs).replace(/\\/g, "/"), abs }))
      .filter(
        (f) =>
          f.path === "src/domain/search-spec.ts" || f.path === "src/domain/serv-boundary.ts",
      );
    expect(files.length).toBe(2);
    for (const f of files) {
      const body = stripComments(readFileSync(f.abs, "utf8"));
      expect(body).not.toMatch(/from\s+["']@\/domain\/note-intake["']/);
      expect(body).not.toMatch(/from\s+["']\.\/note-intake["']/);
    }
  });
});
