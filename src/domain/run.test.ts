import { describe, expect, it } from "vitest";
import { MemoryKv } from "@/io/kv";
import { readRun, updateRun } from "@/io/run-store";
import { buyerHtmlForScan, I6_FORBIDDEN } from "../../test/golden/invariants";
import { renderRunPermalinkHtml } from "./run-view";
import {
  appendClarification,
  applyObservation,
  createRun,
  finalMatchesLastProgress,
  toRunView,
} from "./run";
import { syncRun } from "@/server/run-sync";

const OWNER = "11111111-1111-1111-1111-111111111111";

function draft() {
  return createRun({
    ownerId: OWNER,
    kind: "find",
    inputs: { note: "reliable first car about $8,000", clarifications: [], mode: "personal", vin: null, formEdits: null },
  });
}

const CIVIC = {
  vin: "1HGCM82633A004352",
  year: 2018,
  make: "Honda",
  model: "Civic",
  trim: null,
  priceUsd: 7500,
  miles: 42000,
  dealer: "Main Street Honda",
  vdp: "https://dealer.example/civic",
  city: "New York",
  state: "NY",
};

describe("run settlement", () => {
  it("stores no verdict and no charge when the search finds no cars", () => {
    const settled = applyObservation(draft(), {
      queryCount: 2,
      listings: [],
      verdict: "pass",
      creditsCharged: 1,
      terminal: true,
    });
    expect(settled.verdict).toBeNull();
    expect(settled.creditsCharged).toBe(0);
    expect(settled.phase).toBe("stopped");
    expect(settled.failureReasons).toContain("no_cars");
    expect(finalMatchesLastProgress(settled)).toBe(true);
    const html = renderRunPermalinkHtml(toRunView(settled, null));
    expect(html).not.toMatch(/Verdict:/);
    expect(html).toMatch(/nothing was charged/i);
    expect(html).not.toContain("data-owner-action");
    expect(buyerHtmlForScan(html)).not.toMatch(I6_FORBIDDEN);
  });

  it("keeps the decision on top of the last in-progress snapshot", () => {
    const settled = applyObservation(draft(), {
      queryCount: 1,
      listings: [CIVIC],
      picks: [CIVIC.vin],
      verdict: "buy",
      confidence: "high",
      creditsCharged: 1,
      terminal: true,
      proofs: [{ purpose: "find_decide", status: "ok", responseId: "chatcmpl-secret", elapsedMs: 1200 }],
    });
    expect(settled.verdict).toBe("buy");
    expect(settled.creditsCharged).toBe(1);
    expect(settled.steps.some((step) => step.step === "choose_car" && step.responseId === "chatcmpl-secret" && step.elapsedMs === 1200)).toBe(true);
    expect(finalMatchesLastProgress(settled)).toBe(true);
    const last = settled.progress.at(-1)!;
    expect(last.verdict).toBeNull();
    expect(last.creditsCharged).toBe(0);
    expect(last.listingVins).toEqual([CIVIC.vin]);
    const html = renderRunPermalinkHtml(toRunView(settled, OWNER));
    expect(html).toContain("Verdict: Buy");
    expect(html).toContain("Main Street Honda");
    expect(html).toContain("Listing on dealer.example");
    expect(html).toContain("data-owner-action");
    expect(buyerHtmlForScan(html)).not.toMatch(I6_FORBIDDEN);
    expect(html).toContain("chatcmpl-secret");
  });

  it("a clarification changes the stored spec and leaves the verdict to the server", () => {
    const next = appendClarification(draft(), "it is for a new driver", {
      priceMaxUsd: { value: 8000, origin: "user" as const },
    });
    expect(next.inputs.clarifications).toEqual(["it is for a new driver"]);
    expect(next.spec?.hard.priceMaxUsd).toEqual({ value: 8000, source: "form" });
    expect(next.verdict).toBeNull();
    expect(finalMatchesLastProgress(next)).toBe(true);
  });

  it("round-trips through the key-value store and refuses another owner's edit", async () => {
    const kv = new MemoryKv();
    const id = await syncRun(kv, {
      ownerId: OWNER,
      kind: "find",
      note: "family SUV under $20,000",
      queryCount: 1,
      listings: [],
      terminal: true,
      verdict: "pass",
      creditsCharged: 1,
    });
    expect(id).toBeTruthy();
    const loaded = await readRun(kv, id!);
    expect(loaded?.verdict).toBeNull();
    expect(loaded?.creditsCharged).toBe(0);
    // Code no longer regex-parses budget from the note into SearchSpec.
    expect(loaded?.spec?.hard.priceMaxUsd).toBeUndefined();
    const blocked = await updateRun(kv, id!, (current) => ({ ...current, ownerId: "someone-else" }));
    expect(blocked).toBeNull();
    expect((await readRun(kv, id!))?.ownerId).toBe(OWNER);
  });
});
