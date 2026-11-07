import { describe, expect, it } from "vitest";
import { canTransition, isTerminal } from "./transitions";

describe("scout transitions", () => {
  it("allows created -> mandate_validated", () => {
    expect(canTransition("created", "mandate_validated")).toBe(true);
  });

  it("forbids skipping inventory", () => {
    expect(canTransition("mandate_validated", "selecting")).toBe(false);
  });

  it("forbids leaving terminal states", () => {
    expect(canTransition("completed", "selecting")).toBe(false);
    expect(isTerminal("failed")).toBe(true);
  });
});
