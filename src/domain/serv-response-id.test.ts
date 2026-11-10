import { describe, expect, it } from "vitest";
import {
  isLocalCallUuid,
  isSyntheticChatCmplId,
  isSyntheticTestId,
  providerResponseId,
  providerResponseIdFromCall,
} from "./serv-response-id";

describe("providerResponseId", () => {
  // Provenance: recorded id from eval/results/serv-proof-trace.json (generatedAt 2026-11-06T09:36:15.626Z).
  it("accepts real OpenSERV-style completion ids", () => {
    expect(providerResponseId("chatcmpl-EhAeeqtS7VTM5hgmyZxDbdz7quzxo")).toBe(
      "chatcmpl-EhAeeqtS7VTM5hgmyZxDbdz7quzxo",
    );
  });

  it("rejects bare UUIDs (local callId) and chatcmpl-<uuid>", () => {
    const uuid = "0fc22f78-ff49-41e6-9ac1-25ec62e96e62";
    expect(isLocalCallUuid(uuid)).toBe(true);
    expect(isSyntheticChatCmplId(`chatcmpl-${uuid}`)).toBe(true);
    expect(providerResponseId(uuid)).toBeNull();
    expect(providerResponseId(`chatcmpl-${uuid}`)).toBeNull();
  });

  it("rejects synthetic-test-* unit-test mock ids", () => {
    expect(isSyntheticTestId("synthetic-test-find-pick")).toBe(true);
    expect(providerResponseId("synthetic-test-find-pick")).toBeNull();
    expect(providerResponseId("synthetic-test-decide-soft")).toBeNull();
  });

  it("rejects empty / whitespace", () => {
    expect(providerResponseId(null)).toBeNull();
    expect(providerResponseId("   ")).toBeNull();
  });

  it("never surfaces an id from a failed call, even when shaped like a real completion id", () => {
    expect(
      providerResponseIdFromCall({
        ok: false,
        id: "chatcmpl-EhAeeqtS7VTM5hgmyZxDbdz7quzxo",
      }),
    ).toBeNull();
    expect(
      providerResponseIdFromCall({
        ok: true,
        id: "chatcmpl-EhAeeqtS7VTM5hgmyZxDbdz7quzxo",
      }),
    ).toBe("chatcmpl-EhAeeqtS7VTM5hgmyZxDbdz7quzxo");
  });
});
