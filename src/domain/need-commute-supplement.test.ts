import { describe, expect, it } from "vitest";
import { emptyNeed, supplementNeedFromNote } from "./need";

describe("supplementNeedFromNote useCase", () => {
  it("restores commute when SERV left use unspecified", () => {
    const need = {
      ...emptyNeed("personal"),
      useCase: "unspecified" as const,
      note: "sedan for commute in Columbus OH, under $15k",
    };
    const next = supplementNeedFromNote(need, need.note);
    expect(next.useCase).toBe("commute");
  });
});
