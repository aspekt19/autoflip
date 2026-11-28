import { describe, expect, it } from "vitest";
import { compareWithPickNote, findCardNote } from "./find-card-note";

const winner = { key: "JTDS4MCE8NJ098790", year: 2022, make: "Toyota", model: "Corolla", priceUsd: 14_449, miles: 42_923 };
const camry = { key: "4T1BF1FK5HU644745", year: 2017, make: "Toyota", model: "Camry", priceUsd: 10_449, miles: 83_000 };
const decision = "Best choice on current data: 2022 Toyota Corolla. Medium: fewer miles.";

describe("findCardNote", () => {
  it("shows the decision only on the winning card", () => {
    const won = findCardNote({ car: winner, pick: winner, decisionText: decision, carReason: null });
    expect(won).toEqual({ note: decision, isWinner: true });
    const lost = findCardNote({ car: camry, pick: winner, decisionText: decision, carReason: null });
    expect(lost.isWinner).toBe(false);
    expect(lost.note).not.toContain("Best choice on current data");
  });

  it("gives a non-winning card its own comparison built from its own price and miles", () => {
    expect(compareWithPickNote(camry, winner)).toBe(
      "Compared with the pick (2022 Toyota Corolla): asks $4,000 less, 40,077 more miles.",
    );
    expect(findCardNote({ car: camry, pick: winner, decisionText: decision, carReason: null }).note).toBe(
      "Compared with the pick (2022 Toyota Corolla): asks $4,000 less, 40,077 more miles.",
    );
  });

  it("prefers the reviewer's own line for that car", () => {
    expect(
      findCardNote({ car: camry, pick: winner, decisionText: decision, carReason: "Older, but cheaper." }).note,
    ).toBe("Older, but cheaper.");
  });

  it("invents nothing when price and miles are unknown", () => {
    expect(
      compareWithPickNote({ ...camry, priceUsd: null, miles: null }, winner),
    ).toBeNull();
    expect(compareWithPickNote(winner, winner)).toBeNull();
  });
});
