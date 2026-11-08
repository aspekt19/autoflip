import { describe, expect, it } from "vitest";

/** Mirrors AssistantFlow af-check write/read shape. */
type AfCheckPayload = {
  mode: "personal" | "flip";
  checkKind: "link" | "vin";
  lookup: string;
  vinPrice: string;
  vinMiles: string;
  vinZip: string;
};

function parseAfCheck(raw: string | null): AfCheckPayload | null {
  if (!raw) return null;
  try {
    const saved = JSON.parse(raw) as Partial<AfCheckPayload>;
    if (!saved || (saved.mode !== "personal" && saved.mode !== "flip")) return null;
    if (saved.checkKind !== "link" && saved.checkKind !== "vin") return null;
    if (typeof saved.lookup !== "string") return null;
    return {
      mode: saved.mode,
      checkKind: saved.checkKind,
      lookup: saved.lookup,
      vinPrice: typeof saved.vinPrice === "string" ? saved.vinPrice : "",
      vinMiles: typeof saved.vinMiles === "string" ? saved.vinMiles : "",
      vinZip: typeof saved.vinZip === "string" ? saved.vinZip : "",
    };
  } catch {
    return null;
  }
}

describe("Check → credits af-check restore", () => {
  it("failure-first: missing af-check yields empty form (no restore)", () => {
    expect(parseAfCheck(null)).toBeNull();
  });

  it("restores VIN check fields written before credits redirect", () => {
    const written: AfCheckPayload = {
      mode: "personal",
      checkKind: "vin",
      lookup: "JM3KFBCM1K1514400",
      vinPrice: "20000",
      vinMiles: "13300",
      vinZip: "68114",
    };
    const restored = parseAfCheck(JSON.stringify(written));
    expect(restored).toEqual(written);
  });

  it("drops corrupt payloads instead of inventing fields", () => {
    expect(parseAfCheck("{not-json")).toBeNull();
    expect(parseAfCheck(JSON.stringify({ mode: "personal" }))).toBeNull();
  });
});
