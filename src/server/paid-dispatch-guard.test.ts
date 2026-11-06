import { describe, expect, it } from "vitest";
import { MemoryKv, UpstashKv } from "@/io/kv";
import { isServerlessRuntime, requireSharedQuotaForPaidDispatch } from "./paid-dispatch-guard";

describe("paid dispatch shared-store guard (/find Stage1 follow-on)", () => {
  it("allows Memory/File when not serverless (local offline)", () => {
    expect(requireSharedQuotaForPaidDispatch({ kv: new MemoryKv(), serverless: false }).ok).toBe(true);
  });

  it("fail-closes Memory on serverless before upstream", () => {
    const gate = requireSharedQuotaForPaidDispatch({ kv: new MemoryKv(), serverless: true });
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.error).toBe("quota_backend_not_distributed");
      expect(gate.message).toMatch(/Upstash|shared store/i);
    }
  });

  it("accepts actual Upstash Kv backend on serverless (not env mode alone)", () => {
    const kv = new UpstashKv("https://upstash.test", "tok", (async () =>
      Response.json({ result: null })) as typeof fetch);
    expect(kv.backend).toBe("upstash");
    expect(requireSharedQuotaForPaidDispatch({ kv, serverless: true }).ok).toBe(true);
  });

  it("isServerlessRuntime uses VERCEL / explicit flag — not storageMode string", () => {
    expect(isServerlessRuntime({})).toBe(false);
    expect(isServerlessRuntime({ VERCEL: "1" })).toBe(true);
    expect(isServerlessRuntime({ FIND_REQUIRE_SHARED_QUOTA: "true" })).toBe(true);
  });
});
