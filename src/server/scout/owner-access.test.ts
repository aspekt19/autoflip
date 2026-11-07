import { describe, expect, it } from "vitest";
import { MemoryKv } from "@/io/kv";
import { createApiKey } from "@/server/api-keys";
import { authorizeScoutStart } from "./access";
import {
  isScoutOwnerAllowlisted,
  ownerMayStartScout,
  parseScoutOwnerAllowlist,
} from "./owner-access";

describe("scout owner allowlist", () => {
  it("parses comma/whitespace lists", () => {
    expect(parseScoutOwnerAllowlist({ SCOUT_OWNER_USER_IDS: "a, b;c  d" })).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("when unset, any key may start; when set, only listed userIds", async () => {
    expect(ownerMayStartScout("anyone", {})).toBe(true);
    expect(isScoutOwnerAllowlisted("anyone", {})).toBe(false);

    const kv = new MemoryKv();
    const { token } = await createApiKey(kv, "owner-listed", "t");
    const denied = await authorizeScoutStart(kv, token, "http://localhost", {
      SCOUT_ENABLED: "true",
      SCOUT_OWNER_USER_IDS: "someone-else",
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.body.error).toBe("owner_not_allowlisted");

    const ok = await authorizeScoutStart(kv, token, "http://localhost", {
      SCOUT_ENABLED: "true",
      SCOUT_OWNER_USER_IDS: "owner-listed",
    });
    expect(ok.ok).toBe(true);
  });
});
