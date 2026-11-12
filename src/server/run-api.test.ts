import { describe, expect, it } from "vitest";
import { MemoryKv } from "@/io/kv";
import { readRun } from "@/io/run-store";
import { createRunRequest, getRunRequest, patchRunRequest } from "./run-api";

const OWNER = "22222222-2222-2222-2222-222222222222";
const OTHER = "33333333-3333-3333-3333-333333333333";

describe("run http", () => {
  it("creates a run, lets anyone read it, and only the owner can add a detail", async () => {
    const kv = new MemoryKv();
    const created = await createRunRequest(kv, OWNER, {
      kind: "check",
      note: "1HGCM82633A004352",
      vin: "1HGCM82633A004352",
    });
    expect(created.status).toBe(201);
    const run = created.body.run as { id: string; viewerIsOwner: boolean; permalink: string };
    expect(run.viewerIsOwner).toBe(true);
    expect(run.permalink).toBe(`/run/${run.id}`);

    const anon = await getRunRequest(kv, run.id, null);
    expect(anon.status).toBe(200);
    expect((anon.body.run as { viewerIsOwner: boolean }).viewerIsOwner).toBe(false);

    const refused = await patchRunRequest(kv, run.id, OTHER, { clarification: "check the tires" });
    expect(refused.status).toBe(403);

    const forged = await patchRunRequest(kv, run.id, OWNER, { verdict: "buy", clarification: "ignored" });
    expect(forged.status).toBe(400);
    expect((await readRun(kv, run.id))?.verdict).toBeNull();

    const saved = await patchRunRequest(kv, run.id, OWNER, { clarification: "please look at the recalls" });
    expect(saved.status).toBe(200);
    const stored = await readRun(kv, run.id);
    expect(stored?.inputs.clarifications).toEqual(["please look at the recalls"]);
    expect(stored?.verdict).toBeNull();
  });
});
