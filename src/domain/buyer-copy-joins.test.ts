import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ensureSentenceEnd, joinBuyerParts } from "./buyer-text";
import { plainRepeatLine } from "./serv-decision-journal-copy";

describe("sentence joins", () => {
  it("adds a period when two sentences are joined", () => {
    expect(ensureSentenceEnd("Checks finished")).toBe("Checks finished.");
    expect(ensureSentenceEnd("Checks finished.")).toBe("Checks finished.");
    expect(
      joinBuyerParts(["Checks finished", "Public checks and AI review finished."]),
    ).toBe("Checks finished. Public checks and AI review finished.");
    expect(joinBuyerParts(["Mileage is high", "Ask the seller for the service records."])).toBe(
      "Mileage is high. Ask the seller for the service records.",
    );
  });
});

describe("repeated step lines", () => {
  it("counts a closer look in plain words and does not say repeated", () => {
    expect(plainRepeatLine("We took a closer look at one listing.", 3)).toBe(
      "We took a closer look at 3 listings.",
    );
    expect(plainRepeatLine("We read the factory details.", 2)).toBe(
      "We read the factory details. This came up 2 times.",
    );
    expect(plainRepeatLine("We read the factory details.", 2)).not.toMatch(/repeated/i);
    const journal = readFileSync(new URL("../components/ResaleDecisionJournal.tsx", import.meta.url), "utf8");
    const copy = readFileSync(new URL("./serv-decision-journal-copy.ts", import.meta.url), "utf8");
    expect(journal).not.toMatch(/repeated \$\{/);
    expect(copy).not.toMatch(/repeated \$\{/);
  });
});

describe("resale promise", () => {
  it("does not promise a verdict when no cars match", () => {
    const page = readFileSync(new URL("../app/resale/page.tsx", import.meta.url), "utf8");
    const flow = readFileSync(new URL("../components/ResaleFlow.tsx", import.meta.url), "utf8");
    expect(`${page}\n${flow}`).not.toMatch(/verdict every time|never a dead end|still a verdict/i);
    expect(page).toMatch(/nothing-fits|nothing fit|released/i);
  });
});

describe("running progress type", () => {
  it("does not uppercase the progress label that clipped Closer look", () => {
    const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
    const rule = css.match(/\.progress li \{[^}]*\}/)?.[0] ?? "";
    expect(rule).toMatch(/text-transform:\s*none/);
    expect(rule).not.toMatch(/text-transform:\s*uppercase/);
    expect(rule).toMatch(/font-family:\s*var\(--sans\)/);
  });
});
