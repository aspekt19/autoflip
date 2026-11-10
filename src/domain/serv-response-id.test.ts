import { describe, expect, it } from "vitest";
import {
  isLocalCallUuid,
  isSyntheticChatCmplId,
  providerResponseId,
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

  it("rejects empty / whitespace", () => {
    expect(providerResponseId(null)).toBeNull();
    expect(providerResponseId("   ")).toBeNull();
  });
});
