import { describe, expect, it } from "vitest";
import { clipAtSentenceBoundary, ensureSentenceEnd, limitBuyerText } from "./buyer-text";

describe("clipAtSentenceBoundary", () => {
  it("returns the full string when it already fits", () => {
    expect(clipAtSentenceBoundary("This Sentra has fewer miles.", 280)).toEqual({
      text: "This Sentra has fewer miles.",
      clipped: false,
    });
  });

  it("never cuts mid-word or lets ensureSentenceEnd turn a stump into a false period", () => {
    const reason =
      "This Sentra has 58,185 miles and no reported accidents, though that does not confirm a clean history; compared with the lower-mileage alternative 2025 Nissan Sentra ($14,750, 9,354 mi), its accident and owner counts are known only as “0 reported” and 1 owner, while that alternative is the lower-mile car and needs a closer look at the service history.";
    expect(reason.length).toBeGreaterThan(280);
    const hardCut = `${reason.slice(0, 280)}`;
    expect(hardCut).toMatch(/alternati$/);
    const stored = limitBuyerText(reason, 2000);
    expect(stored).toBe(reason);
    expect(stored).not.toMatch(/alternati$/);
    const clipped = clipAtSentenceBoundary(reason, 280);
    expect(clipped.clipped).toBe(true);
    expect(clipped.text).toMatch(/…$/);
    expect(clipped.text).not.toMatch(/alternati\.$/);
    expect(clipped.text).not.toMatch(/\balternati\b/);
    expect(ensureSentenceEnd(clipped.text)).toBe(clipped.text);
  });

  it("clips at the last sentence that fits, with an ellipsis", () => {
    const text = "First sentence is short. Second sentence is also short. Third continues for a while after that.";
    const clipped = clipAtSentenceBoundary(text, 50);
    expect(clipped.clipped).toBe(true);
    expect(clipped.text).toBe("First sentence is short.…");
  });
});
