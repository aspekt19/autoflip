/**
 * OpenServ prompt cache keys on the system prompt (+ transform type), not the model.
 * Instructions must be byte-identical across turns of the same flow.
 */
import { describe, expect, it } from "vitest";
import {
  findAgentRequestContextMessage,
  findAgentStableInstructions,
} from "@/server/find-agent/loop";
import {
  resaleAgentRequestContextMessage,
  resaleAgentStableInstructions,
} from "@/server/resale-agent/loop";

describe("byte-stable agent instructions (prompt cache)", () => {
  it("Find instructions are identical across turns with different transcripts", () => {
    const a = findAgentStableInstructions();
    const b = findAgentStableInstructions();
    expect(a).toBe(b);
    expect(a).not.toMatch(/Shopper conversation \/ note:/i);
    expect(a).not.toMatch(/\$\d/);
    expect(a).toMatch(/input messages/i);

    const ctx1 = findAgentRequestContextMessage("Toyota under $20k in 33101");
    const ctx2 = findAgentRequestContextMessage("Honda near Austin, budget 15k");
    expect(ctx1).not.toBe(ctx2);
    expect(ctx1).toMatch(/Shopper conversation \/ note:/);
    expect(ctx2).toMatch(/Shopper conversation \/ note:/);
  });

  it("Resale instructions are identical across turns with different notes", () => {
    const a = resaleAgentStableInstructions();
    const b = resaleAgentStableInstructions();
    expect(a).toBe(b);
    expect(a).not.toMatch(/Shopper note:/i);
    expect(a).toMatch(/input messages/i);

    const ctx1 = resaleAgentRequestContextMessage("Flip Camry under 12k in 78701");
    const ctx2 = resaleAgentRequestContextMessage("Wholesale SUV under 18k near Dallas");
    expect(ctx1).not.toBe(ctx2);
    expect(ctx1).toMatch(/Shopper note:/);
  });
});
