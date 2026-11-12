import { describe, expect, it } from "vitest";
import { findDecidePathEnabled, shouldAutoStartFindDecide } from "./find-decide-path";

describe("findDecidePathEnabled", () => {
  it("stays on after the next-check loop was removed", () => {
    expect(findDecidePathEnabled({})).toBe(true);
    expect(findDecidePathEnabled({ FIND_DECIDE_PATH: "0" })).toBe(true);
    expect(findDecidePathEnabled({ FIND_DECIDE_PATH: "false" })).toBe(true);
    expect(findDecidePathEnabled({ FIND_DECIDE_PATH: "off" })).toBe(true);
  });
});

describe("shouldAutoStartFindDecide", () => {
  it("returns token once per search", () => {
    expect(
      shouldAutoStartFindDecide({
        decidePathEnabled: true,
        searchContextToken: "abc",
        alreadyAutoStartedForToken: null,
      }),
    ).toBe("abc");
    expect(
      shouldAutoStartFindDecide({
        decidePathEnabled: true,
        searchContextToken: "abc",
        alreadyAutoStartedForToken: "abc",
      }),
    ).toBeNull();
  });

  it("stays off when path disabled", () => {
    expect(
      shouldAutoStartFindDecide({
        decidePathEnabled: false,
        searchContextToken: "abc",
        alreadyAutoStartedForToken: null,
      }),
    ).toBeNull();
  });
});
