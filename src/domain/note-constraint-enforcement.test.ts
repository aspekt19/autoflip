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


  it("production src no longer defines note interpreters for use-case/budget/year/AWD", () => {
    const need = stripComments(readFileSync(join(SRC, "domain/need.ts"), "utf8"));
    for (const forbidden of [
      "useCaseFromText",
      "budgetIsApproximateFromNote",
      "makesFromText",
      "preferredModelsFromText",
      "bodyFromNote",
      "needPrefersAwd",
      "softPrefGapsFromText",
      "yearBandForBudget",
      "supplementNeedFromNote",
    ]) {
      expect(need, `need.ts still exports ${forbidden}`).not.toMatch(new RegExp(`\\bexport function ${forbidden}\\b`));
    }
  });

  it("find-match no longer ranks or diversifies inventory", () => {
    const text = stripComments(readFileSync(join(SRC, "server/find-match.ts"), "utf8"));
    expect(text).not.toMatch(/\bpersonalRankScores\b/);
    expect(text).not.toMatch(/\bselectBestDealOnEvidence\b/);
    expect(text).not.toMatch(/\bdiversifyListingsByModel\b/);
    expect(text).not.toMatch(/\bwithinBudget\b/);
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

describe("note→search enforcement — no free-text readers / catalogs outside SERV client", () => {
  /**
   * SERV client = src/server/serv/** (HTTP transport). Agent loops may embed the
   * shopper note as opaque prompt text. Anti-fab quote grounding may check that a
   * SERV quote substring appears in the note. Everything else must not regex /
   * keyword-scan need.note / mustHaves to invent searches or constraints.
   */
  const SERV_CLIENT_PREFIXES = ["src/server/serv/"];
  const NOTE_READ_ALLOWLIST = new Set([
    // Anti-fab: quote / token grounding against the shopper note.
    "src/domain/find-plan.ts",
    "src/domain/search-spec.ts",
    "src/domain/serv-boundary.ts",
    "src/domain/run-invariants.ts",
    // Opaque pass-through of note into SERV prompts / tools.
    "src/server/find-agent/loop.ts",
    "src/server/find-agent/tools.ts",
    "src/server/resale-agent/loop.ts",
    "src/server/understand-need.ts",
    "src/server/find-decide-serv.ts",
    "src/server/find-triage-serv.ts",
    "src/server/find-decide-orchestrator.ts",
    "src/server/find-settle-serv.ts",
    "src/server/shopper-verdict-serv.ts",
    "src/server/radar-serv.ts",
  ]);

  const FORBIDDEN_SYMBOLS = [
    "proposeDirections",
    "previewFindFromNote",
    "broadenStarterDirections",
    "broadenOpenDirections",
    "isOpenStarterNote",
    "buyerNamedStarterModel",
    "towingCapacityCaveat",
    "unnamedTruckRequest",
    "noteNames",
    "requestedBody",
    "directionsFor",
    "STARTER_FIRST_WAVE",
    "STARTER_RETRY_WAVE",
    "OPEN_TRUCK_MODELS",
    "SOFT_HYBRID_MODELS",
    "CROSSOVERS",
    "COMPACTS",
    "MIDSIZE",
  ];

  /** Regex / includes applied to shopper need.note / run.note free text. */
  const NOTE_INTERPRET_RE =
    /(?:need\.note|input\.note|opts\.note|run\.note)\s*(?:\?\.)?\s*(?:\.toLowerCase\(\)\s*)?\.(?:test|includes|match)\s*\(/;
  const MUSTHAVES_INTERPRET_RE =
    /mustHaves(?:\s*\?\?\s*\[\])?[^\n]{0,80}\.(?:test|includes|match)\s*\(/;
  const KEYWORD_ON_NOTE_RE =
    /\/\\b(?:first car|new driver|tow(?:ing|s|ed)?|trailer|awd|4wd|hybrid|suv|truck|sedan|college)\\b\/[a-z]*\.test\([^)]*note/;

  it("deleted note/catalog modules stay gone", () => {
    for (const rel of [
      "src/domain/open-search.ts",
      "src/domain/starter-search.ts",
      "src/domain/find-preview.ts",
    ]) {
      expect(() => readFileSync(join(ROOT, rel), "utf8"), `${rel} must stay deleted`).toThrow();
    }
  });

  it("no production src outside SERV client interprets shopper note / mustHaves free text", () => {
    const hits: string[] = [];
    for (const abs of walkTsFiles(SRC)) {
      const path = relative(ROOT, abs).replace(/\\/g, "/");
      if (SERV_CLIENT_PREFIXES.some((p) => path.startsWith(p))) continue;
      if (NOTE_READ_ALLOWLIST.has(path)) continue;
      const body = stripComments(readFileSync(abs, "utf8"));
      for (const sym of FORBIDDEN_SYMBOLS) {
        // Allow comments that say the symbol was deleted.
        if (new RegExp(`\\b${sym}\\b`).test(body) && !new RegExp(`(?:deleted|removed|no code).*\\b${sym}\\b`, "i").test(body)) {
          // Symbol as identifier use (not only in a prose comment mentioning deletion).
          if (new RegExp(`(?:function|const|let|var|import|{|,)\\s*${sym}\\b|\\b${sym}\\s*(?:\\(|=|,|})`).test(body)) {
            hits.push(`${path}: forbidden symbol ${sym}`);
          }
        }
      }
      if (NOTE_INTERPRET_RE.test(body)) hits.push(`${path}: note .test/.includes/.match`);
      if (MUSTHAVES_INTERPRET_RE.test(body)) hits.push(`${path}: mustHaves .test/.includes/.match`);
      if (KEYWORD_ON_NOTE_RE.test(body)) hits.push(`${path}: keyword regex on note`);
    }
    expect(hits).toEqual([]);
  });

  it("directions.ts has no hardcoded make/model search catalogs", () => {
    const text = stripComments(readFileSync(join(SRC, "domain/directions.ts"), "utf8"));
    expect(text).not.toMatch(/\bCROSSOVERS\b/);
    expect(text).not.toMatch(/\bCOMPACTS\b/);
    expect(text).not.toMatch(/\bTRUCKS\b/);
    expect(text).not.toMatch(/\bMIDSIZE\b/);
    expect(text).not.toMatch(/\bproposeDirections\b/);
    expect(text).not.toMatch(/\brequestedBody\b/);
  });

  it("resale-search does not call proposeDirections", () => {
    const text = stripComments(readFileSync(join(SRC, "server/resale-search.ts"), "utf8"));
    expect(text).not.toMatch(/\bproposeDirections\b/);
    expect(text).toMatch(/search_listings/);
  });

  it("resale-search-input never regexes freeText/note for asIs or sellWithinDays", () => {
    const text = stripComments(readFileSync(join(SRC, "domain/resale-search-input.ts"), "utf8"));
    expect(text).not.toMatch(/freeTextForFlags/);
    expect(text).not.toMatch(/\\bas\[-\\s\]\?is\\b/);
    expect(text).not.toMatch(/sell\s*\+\s*within/);
    expect(text).not.toMatch(/\.test\(\s*freeText/);
    expect(text).not.toMatch(/\.match\(\s*(?:freeText|note)/);
    // Form/SERV boolean + number fields remain the only writers.
    expect(text).toMatch(/typeof body\.asIs === "boolean"/);
    expect(text).toMatch(/body\.sellWithinDays/);
  });

  it("Radar watch-queries never invents Flip make/model catalogs", () => {
    const text = stripComments(readFileSync(join(SRC, "domain/watch-queries.ts"), "utf8"));
    expect(text).not.toMatch(/\bFLIP_BROAD_SCAN_MODELS\b/);
    expect(text).not.toMatch(/\bFLIP_SCAN_PAGES\b/);
    expect(text).not.toMatch(/Corolla/);
    expect(text).not.toMatch(/RAV4/);
    expect(text).not.toMatch(/Camry/);
    // Unnamed Flip still builds criteria queries; it must not substitute models.
    expect(text).toMatch(/\bisBroadFlip\b/);
    expect(text).toMatch(/\blistingQueries\b/);
  });

  it("dead note-preference stubs stay deleted", () => {
    const text = stripComments(readFileSync(join(SRC, "domain/find-best-deal.ts"), "utf8"));
    for (const forbidden of [
      "prefersConditionFromNote",
      "prefersNotTooOldFromNote",
      "prefersLowMilesFromNote",
      "safetyOrientedRequest",
      "PRE_ESC_RANK_NOTE",
    ]) {
      expect(text, `find-best-deal still has ${forbidden}`).not.toMatch(new RegExp(`\\b${forbidden}\\b`));
    }
  });

  it("walk: no production src regexes shopper freeText/note for asIs/sellWindow or invents Flip models", () => {
    const hits: string[] = [];
    // Literal patterns that used to mint Resale/Radar constraints from free text.
    const FORBIDDEN_SNIPPETS = [
      { re: /freeTextForFlags/, label: "freeTextForFlags" },
      { re: /\\bas\[-\\s\]\?is\\b/, label: "as-is regex" },
      { re: /sell\\s\+within.*?days/, label: "sell-within regex" },
      { re: /\bFLIP_BROAD_SCAN_MODELS\b/, label: "FLIP_BROAD_SCAN_MODELS" },
      { re: /\bFLIP_SCAN_PAGES\b/, label: "FLIP_SCAN_PAGES" },
      { re: /\bprefersConditionFromNote\b/, label: "prefersConditionFromNote" },
      { re: /\bprefersNotTooOldFromNote\b/, label: "prefersNotTooOldFromNote" },
      { re: /\bprefersLowMilesFromNote\b/, label: "prefersLowMilesFromNote" },
      { re: /\bsafetyOrientedRequest\b/, label: "safetyOrientedRequest" },
    ];
    const HARDCODED_LIQUID_FLIP =
      /make:\s*["']Toyota["']\s*,\s*model:\s*["']Corolla["'][\s\S]{0,160}make:\s*["']Toyota["']\s*,\s*model:\s*["']RAV4["'][\s\S]{0,160}make:\s*["']Toyota["']\s*,\s*model:\s*["']Camry["']/;

    for (const abs of walkTsFiles(SRC)) {
      const path = relative(ROOT, abs).replace(/\\/g, "/");
      const body = stripComments(readFileSync(abs, "utf8"));
      for (const { re, label } of FORBIDDEN_SNIPPETS) {
        if (!re.test(body)) continue;
        // Dealer listing page phrase scans are not shopper freeText interpreters.
        if (label === "as-is regex" && path === "src/domain/listing/red-flags.ts") continue;
        hits.push(`${path}: ${label}`);
      }
      if (HARDCODED_LIQUID_FLIP.test(body)) hits.push(`${path}: Corolla/RAV4/Camry Flip catalog`);
    }
    expect(hits).toEqual([]);
  });
});
