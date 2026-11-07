/**
 * Stage1B — Autodev fetch must honor caller mid-flight AbortSignal + own timeout.
 * Contract: cancel AFTER fetch started → mock fetch sees signal.aborted (not pre-abort only).
 */
import { describe, expect, it } from "vitest";
import { TtlCache } from "./cache";
import { MemoryCounter } from "./quota";
import { autodevSearch } from "./autodev";
import { combineAbortSignals } from "./abort-signal";

describe("Stage1B Autodev AbortSignal combine", () => {
  it("combineAbortSignals aborts when caller fires before timeout", async () => {
    const caller = new AbortController();
    const combined = combineAbortSignals(caller.signal, 60_000);
    expect(combined.aborted).toBe(false);
    caller.abort();
    expect(combined.aborted).toBe(true);
  });

  it("cancel after fetch started aborts the real fetch signal", async () => {
    const counter = new MemoryCounter();
    const cache = new TtlCache<unknown>();
    const caller = new AbortController();
    let fetchEntered!: () => void;
    const entered = new Promise<void>((r) => {
      fetchEntered = r;
    });
    let sawAborted = false;

    const fetchImpl: typeof fetch = async (_url, init) => {
      fetchEntered();
      const signal = init?.signal;
      expect(signal).toBeTruthy();
      await new Promise<void>((resolve, reject) => {
        if (!signal) {
          reject(new Error("missing signal"));
          return;
        }
        if (signal.aborted) {
          sawAborted = true;
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            sawAborted = true;
            expect(signal.aborted).toBe(true);
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      });
      return new Response("should not reach", { status: 500 });
    };

    const pending = autodevSearch(
      { make: "Toyota", model: "Camry" },
      {
        fetch: fetchImpl,
        cache,
        counter,
        apiKey: "test-key",
        now: new Date("2026-11-04T00:00:00Z"),
        signal: caller.signal,
      },
    );

    await entered; // fetch is mid-flight
    caller.abort();
    const result = await pending;
    expect(sawAborted).toBe(true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("upstream");
    // Reservation consumed (counter incremented) — ambiguous cancel must not refund here.
    expect(counter.get("2026-11")).toBe(1);
  });

  it("own timeout still aborts when no caller signal", async () => {
    const counter = new MemoryCounter();
    const cache = new TtlCache<unknown>();
    let sawTimeoutAbort = false;
    const fetchImpl: typeof fetch = async (_url, init) => {
      const signal = init?.signal;
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            sawTimeoutAbort = true;
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      });
      return new Response("no", { status: 500 });
    };

    const result = await autodevSearch(
      { make: "Toyota" },
      {
        fetch: fetchImpl,
        cache,
        counter,
        apiKey: "test-key",
        now: new Date("2026-11-04T00:00:00Z"),
        // Very short ownership timeout for the test.
        timeoutMs: 30,
      },
    );
    expect(sawTimeoutAbort).toBe(true);
    expect(result.ok).toBe(false);
  });
});
