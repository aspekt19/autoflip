import { describe, expect, it } from "vitest";
import {
  isLocalCallUuid,
  isSyntheticChatCmplId,
  isSyntheticTestId,
  providerResponseId,
  providerResponseIdFromCall,
} from "./serv-response-id";

describe("providerResponseId", () => {
  it("accepts real OpenSERV-style completion ids", () => {
    expect(providerResponseId("chatcmpl-Eia7lwQyEdrZ4bOTwmVam3kWBjvp1")).toBe(
      "chatcmpl-Eia7lwQyEdrZ4bOTwmVam3kWBjvp1",
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
        id: "chatcmpl-Eia7lwQyEdrZ4bOTwmVam3kWBjvp1",
      }),
    ).toBeNull();
    expect(
      providerResponseIdFromCall({
        ok: true,
        id: "chatcmpl-Eia7lwQyEdrZ4bOTwmVam3kWBjvp1",
      }),
    ).toBe("chatcmpl-Eia7lwQyEdrZ4bOTwmVam3kWBjvp1");
  });
});
