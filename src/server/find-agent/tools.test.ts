import { describe, expect, it } from "vitest";
import { TtlCache } from "@/io/cache";
import { MemoryCounter } from "@/io/quota";
import {
  createFindAgentToolState,
  executeFindAgentTool,
  parseLimitArg,
  parseSearchListingsArgs,
  parseZipArg,
} from "./tools";

describe("find-agent tool arg validation", () => {
  it("rejects a bad zip", () => {
    const bad = parseZipArg("ABCDE");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues[0]?.field).toBe("zip");
  });

  it("accepts a 5-digit zip", () => {
    const ok = parseZipArg("33101");
    expect(ok).toEqual({ ok: true, value: "33101" });
  });

  it("rejects limit over 20", () => {
    const bad = parseLimitArg(50);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.issues[0]?.field).toBe("limit");
  });

  it("rejects search_listings with bad zip and limit together", () => {
    const bad = parseSearchListingsArgs({ make: "Toyota", zip: "nope", limit: 99 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.issues.some((i) => i.field === "zip")).toBe(true);
      expect(bad.issues.some((i) => i.field === "limit")).toBe(true);
    }
  });
});

describe("search_listings funnel (Sedan bodyStyle)", () => {
  it("omits Sedan on the provider URL and reports funnelHint when raw is empty", async () => {
    let requestedUrl = "";
    const fetchImpl: typeof fetch = async (input) => {
      requestedUrl = String(input);
      if (requestedUrl.includes("listings")) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 404 });
    };
    const executed = await executeFindAgentTool(
      "search_listings",
      { make: "Toyota", bodyStyle: "Sedan", zip: "43215", radiusMi: 100, limitMaxUsd: 11000 },
      {
        fetch: fetchImpl,
        autodevKey: "test",
        autodev: { cache: new TtlCache<unknown>(), counter: new MemoryCounter() },
      },
      createFindAgentToolState(),
    );
    expect(executed.ok).toBe(true);
    expect(requestedUrl).not.toMatch(/bodyStyle=Sedan/i);
    expect(executed.result.providerBodyStyle).toBeNull();
    expect(executed.result.count).toBe(0);
    expect(String(executed.result.funnelHint ?? "")).toMatch(/0|relax/i);
  });
});
