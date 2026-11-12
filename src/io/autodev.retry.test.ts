import { describe, expect, it, vi } from "vitest";
import { TtlCache } from "./cache";
import { MemoryCounter } from "./quota";
import {
  AUTODEV_DEFAULT_TIMEOUT_MS,
  autodevSearch,
  type AutodevDeps,
} from "./autodev";

function deps(over: Partial<AutodevDeps> & Pick<AutodevDeps, "fetch">): AutodevDeps {
  return {
    cache: new TtlCache<unknown>(),
    counter: new MemoryCounter(),
    apiKey: "test-key",
    now: new Date("2026-11-12T00:00:00Z"),
    retryBaseMs: 1,
    sleep: async () => undefined,
    ...over,
  };
}

describe("autodev I/O reliability", () => {
  it("defaults to a generous timeout (not a short 12s cut)", () => {
    expect(AUTODEV_DEFAULT_TIMEOUT_MS).toBeGreaterThanOrEqual(45_000);
    expect(AUTODEV_DEFAULT_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
  });

  it("retries transient 503 then succeeds, reserving quota once", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      if (calls < 3) return new Response("busy", { status: 503 });
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const counter = new MemoryCounter();
    const result = await autodevSearch(
      { make: "Toyota", model: "Camry" },
      deps({ fetch: fetchImpl, counter, maxAttempts: 3 }),
    );
    expect(result.ok).toBe(true);
    expect(calls).toBe(3);
    expect(counter.get("2026-11")).toBe(1);
  });

  it("retries timeout then surfaces cause=timeout with status 0", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      const err = new DOMException("The operation was aborted due to timeout", "TimeoutError");
      throw err;
    };
    const result = await autodevSearch(
      { make: "Honda" },
      deps({ fetch: fetchImpl, maxAttempts: 2 }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("upstream");
    if (result.error !== "upstream") return;
    expect(result.status).toBe(0);
    expect(result.cause).toBe("timeout");
    expect(result.attempts).toBe(2);
    expect(result.message).toMatch(/timed out/i);
    expect(calls).toBe(2);
  });

  it("does not retry permanent 400; passes real HTTP status", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response("bad", { status: 400 });
    };
    const result = await autodevSearch({ make: "Ford" }, deps({ fetch: fetchImpl, maxAttempts: 3 }));
    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
    if (result.ok || result.error !== "upstream") return;
    expect(result.status).toBe(400);
    expect(result.cause).toBe("http_error");
    expect(result.message).toMatch(/HTTP 400/);
  });

  it("retries 429 then reports status 429", async () => {
    const fetchImpl: typeof fetch = async () => new Response("slow down", { status: 429 });
    const result = await autodevSearch(
      { make: "Mazda" },
      deps({ fetch: fetchImpl, maxAttempts: 2 }),
    );
    expect(result.ok).toBe(false);
    if (result.ok || result.error !== "upstream") return;
    expect(result.status).toBe(429);
    expect(result.cause).toBe("http_error");
    expect(result.message).toMatch(/429/);
  });

  it("does not retry when the caller AbortSignal is already aborted", async () => {
    const caller = new AbortController();
    caller.abort();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    };
    const result = await autodevSearch(
      { make: "Kia" },
      deps({ fetch: fetchImpl, signal: caller.signal, maxAttempts: 3 }),
    );
    expect(calls).toBe(0);
    expect(result.ok).toBe(false);
    if (result.ok || result.error !== "upstream") return;
    expect(result.cause).toBe("aborted");
  });
});

describe("autodev backoff helper wiring", () => {
  it("sleeps between retries with increasing delays", async () => {
    const sleeps: number[] = [];
    const fetchImpl: typeof fetch = async () => new Response("nope", { status: 502 });
    await autodevSearch(
      { make: "Subaru" },
      deps({
        fetch: fetchImpl,
        maxAttempts: 3,
        retryBaseMs: 10,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      }),
    );
    expect(sleeps).toEqual([10, 20]);
  });
});

// Keep vi import used when assertions evolve.
void vi;
