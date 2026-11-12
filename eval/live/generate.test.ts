import { describe, expect, it } from "vitest";
import { generateQueries } from "./generate";

describe("generateQueries", () => {
  it("is deterministic for a fixed seed and yields ≥20 unique notes", () => {
    const a = generateQueries(42_001, 24);
    const b = generateQueries(42_001, 24);
    expect(a).toHaveLength(24);
    expect(b).toHaveLength(24);
    expect(a.map((q) => q.note)).toEqual(b.map((q) => q.note));
    expect(a.map((q) => q.id)).toEqual(b.map((q) => q.id));
    const unique = new Set(a.map((q) => q.note));
    expect(unique.size).toBeGreaterThanOrEqual(20);
  });

  it("changes notes when the seed changes", () => {
    const a = generateQueries(1, 24).map((q) => q.note);
    const b = generateQueries(2, 24).map((q) => q.note);
    expect(a).not.toEqual(b);
  });
});
