import { describe, expect, it } from "vitest";
import type { Kv } from "@/io/kv";
import { authorizeScoutStart } from "./access";
import { isScoutEnabled } from "./config";

function memoryKv(map = new Map<string, string>()): Kv {
  return {
    async get(key: string) {
      return map.get(key) ?? null;
    },
    async set(key: string, value: string) {
      map.set(key, value);
    },
    async setNx(key: string, value: string) {
      if (map.has(key)) return false;
      map.set(key, value);
      return true;
    },
    async delete(key: string) {
      map.delete(key);
    },
  };
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
