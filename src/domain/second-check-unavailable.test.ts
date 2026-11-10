import { describe, expect, it } from "vitest";
import {
  secondCheckUnavailableLabel,
  shortSecondCheckUnavailableReason,
} from "./second-check-unavailable";

describe("shortSecondCheckUnavailableReason", () => {
  it("maps structured refusal field to a short buyer reason", () => {
    expect(
      shortSecondCheckUnavailableReason({
        error: "SERV structured refusal field (message_content_null_refusal_field).",
        status: 200,
        reasonCode: "message_content_null_refusal_field",
      }),
    ).toBe("model returned a refusal with no usable answer");
  });

  it("formats the UI label", () => {
    expect(secondCheckUnavailableLabel("timed out")).toBe("Second check unavailable: timed out");
  });
});
