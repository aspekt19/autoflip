import { describe, expect, it } from "vitest";
import { countByProduct, DEFAULT_EVAL_QUERIES, generateQueries, splitFindResale } from "./generate";

describe("generateQueries", () => {
  it("defaults to 8 queries with ~5 Find + 3 Resale", () => {
    const a = generateQueries(42_001);
    const b = generateQueries(42_001, DEFAULT_EVAL_QUERIES);
    expect(a).toHaveLength(8);
    expect(b).toHaveLength(8);
    expect(a.map((q) => q.note)).toEqual(b.map((q) => q.note));
    expect(countByProduct(a)).toEqual({ find: 5, resale: 3 });
    expect(new Set(a.map((q) => q.note)).size).toBe(8);
  });

  it("is deterministic for a fixed seed", () => {
    const a = generateQueries(42_001, 8);
    const b = generateQueries(42_001, 8);
    expect(a.map((q) => q.id)).toEqual(b.map((q) => q.id));
    expect(a.map((q) => q.product)).toEqual(b.map((q) => q.product));
  });

  it("changes notes when the seed changes", () => {
    const a = generateQueries(1, 8).map((q) => q.note);
    const b = generateQueries(2, 8).map((q) => q.note);
    expect(a).not.toEqual(b);
  });

  it("broadens the pool so many seeds yield mostly unique notes", () => {
    const notes = new Set<string>();
    for (let seed = 100; seed < 140; seed += 1) {
      for (const q of generateQueries(seed, 8)) notes.add(q.note);
    }
    // 40 seeds × 8 queries = 320 slots; expanded templates should keep most unique.
    expect(notes.size).toBeGreaterThan(200);
  });

  it("splitFindResale keeps the 5/3 mix at 8", () => {
    expect(splitFindResale(8)).toEqual({ find: 5, resale: 3 });
    expect(splitFindResale(1)).toEqual({ find: 1, resale: 0 });
  });
});
