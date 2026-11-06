import { describe, expect, it } from "vitest";
import { MemoryKv } from "@/io/kv";
import { authorizeScoutStart } from "./access";
import { isScoutEnabled } from "./config";

function memoryKv(): MemoryKv {
  return new MemoryKv();
}

describe("scout access", () => {
  it("defaults SCOUT_ENABLED off", () => {
    expect(isScoutEnabled({})).toBe(false);
    expect(isScoutEnabled({ SCOUT_ENABLED: "false" })).toBe(false);
    expect(isScoutEnabled({ SCOUT_ENABLED: "true" })).toBe(true);
  });

  it("rejects when disabled even with a bearer token", async () => {
    const result = await authorizeScoutStart(memoryKv(), "af_test", "http://localhost", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.body.error).toBe("scout_disabled");
    }
  });

  it("rejects unauthenticated when enabled", async () => {
    const result = await authorizeScoutStart(memoryKv(), null, "http://localhost", {
      SCOUT_ENABLED: "true",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.body.error).toBe("api_key_required");
    }
  });
});
