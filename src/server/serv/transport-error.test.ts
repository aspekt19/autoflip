import { describe, expect, it } from "vitest";
import { classifyServTransportError, isServRetryableFailure } from "./transport-error";

describe("classifyServTransportError", () => {
  it("classifies timeout and network without leaking stacks", () => {
    expect(classifyServTransportError(new DOMException("Timed out", "TimeoutError")).class).toBe(
      "timeout",
    );
    expect(classifyServTransportError(new Error("fetch failed")).class).toBe("network");
    expect(classifyServTransportError(new Error("ECONNRESET")).detail).not.toMatch(/ECONNRESET/);
  });
});

describe("isServRetryableFailure", () => {
  it("retries network, 5xx, unparseable, and invalid output only — not timeout/abort", () => {
    expect(
      isServRetryableFailure({ ok: false, errorClass: "network", status: 0 }),
    ).toBe(true);
    expect(
      isServRetryableFailure({ ok: false, status: 503, errorClass: "http_5xx" }),
    ).toBe(true);
    expect(isServRetryableFailure({ ok: false, unparseable: true })).toBe(true);
    expect(isServRetryableFailure({ ok: false, validationFailed: true })).toBe(true);
    expect(
      isServRetryableFailure({ ok: false, errorClass: "timeout", status: 0 }),
    ).toBe(false);
    expect(
      isServRetryableFailure({ ok: false, errorClass: "abort", status: 0 }),
    ).toBe(false);
    expect(isServRetryableFailure({ ok: true })).toBe(false);
  });
});
