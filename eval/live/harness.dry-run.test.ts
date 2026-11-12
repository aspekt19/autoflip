import { describe, expect, it } from "vitest";
import { main } from "./harness";

describe("eval:live dry-run", () => {
  it("exits 0 without network when EVAL_LIVE_ALLOW_PAID is unset", async () => {
    const priorAllow = process.env.EVAL_LIVE_ALLOW_PAID;
    const priorSeed = process.env.EVAL_LIVE_SEED;
    delete process.env.EVAL_LIVE_ALLOW_PAID;
    process.env.EVAL_LIVE_SEED = "991122";
    try {
      const code = await main([]);
      expect(code).toBe(0);
    } finally {
      if (priorAllow === undefined) delete process.env.EVAL_LIVE_ALLOW_PAID;
      else process.env.EVAL_LIVE_ALLOW_PAID = priorAllow;
      if (priorSeed === undefined) delete process.env.EVAL_LIVE_SEED;
      else process.env.EVAL_LIVE_SEED = priorSeed;
    }
  });
});
