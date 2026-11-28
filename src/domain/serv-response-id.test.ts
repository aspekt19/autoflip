import { describe, expect, it } from "vitest";
import {
  graphIdFromModel,
  isGraphModelId,
  isLocalCallUuid,
  isSyntheticTestId,
  journalModelRunText,
  journalProviderRunId,
  providerGraphRunId,
  providerResponseId,
  providerResponseIdFromCall,
} from "./serv-response-id";

describe("providerResponseId", () => {
  // Provenance: recorded id from eval/results/serv-proof-trace.json (generatedAt 2026-11-06T09:36:15.626Z).
  it("accepts real OpenSERV-style completion ids", () => {
    expect(providerResponseId("chatcmpl-EhAeeqtS7VTM5hgmyZxDbdz7quzxo")).toBe(
      "chatcmpl-EhAeeqtS7VTM5hgmyZxDbdz7quzxo",
    );
  });

  it("rejects bare UUIDs (local callId) and synthetic-test-<uuid>", () => {
    const uuid = "0fc22f78-ff49-41e6-9ac1-25ec62e96e62";
    expect(isLocalCallUuid(uuid)).toBe(true);
    expect(isSyntheticTestId(`synthetic-test-${uuid}`)).toBe(true);
    expect(providerResponseId(uuid)).toBeNull();
    expect(providerResponseId(`synthetic-test-${uuid}`)).toBeNull();
  });

  it("rejects synthetic-test-* unit-test mock ids", () => {
    expect(isSyntheticTestId("synthetic-test-find-pick")).toBe(true);
    expect(providerResponseId("synthetic-test-find-pick")).toBeNull();
    expect(providerResponseId("synthetic-test-decide-soft")).toBeNull();
  });

  it("rejects empty / whitespace", () => {
    expect(providerResponseId(null)).toBeNull();
    expect(providerResponseId("   ")).toBeNull();
  });

  it("keeps a real completion id when the call failed, and still drops synthetic ids", () => {
    expect(
      providerResponseIdFromCall({
        ok: false,
        id: "chatcmpl-EhAeeqtS7VTM5hgmyZxDbdz7quzxo",
      }),
    ).toBe("chatcmpl-EhAeeqtS7VTM5hgmyZxDbdz7quzxo");
    expect(
      providerResponseIdFromCall({
        ok: false,
        id: "synthetic-test-find-pick",
      }),
    ).toBeNull();
    expect(
      providerResponseIdFromCall({
        ok: true,
        id: "chatcmpl-EhAeeqtS7VTM5hgmyZxDbdz7quzxo",
      }),
    ).toBe("chatcmpl-EhAeeqtS7VTM5hgmyZxDbdz7quzxo");
  });
});


describe("providerGraphRunId", () => {
  const graphUuid = "d5e38f1b-fd4c-4401-aa06-e92c7b350f72";

  it("keeps OpenServ graph request UUIDs and ordinary graph run ids", () => {
    expect(providerGraphRunId(graphUuid)).toBe(graphUuid);
    expect(providerGraphRunId("run_chk1")).toBe("run_chk1");
    expect(providerGraphRunId("chatcmpl-EhAeeqtS7VTM5hgmyZxDbdz7quzxo")).toBe(
      "chatcmpl-EhAeeqtS7VTM5hgmyZxDbdz7quzxo",
    );
  });

  it("still drops synthetic-test and chatcmpl-<uuid> shapes", () => {
    expect(providerGraphRunId(`synthetic-test-${graphUuid}`)).toBeNull();
    expect(providerGraphRunId("synthetic-test-find-pick")).toBeNull();
    expect(providerGraphRunId(`chatcmpl-${graphUuid}`)).toBeNull();
    expect(providerGraphRunId("  ")).toBeNull();
  });

  it("journalProviderRunId keeps UUIDs only for graph models, not Radar local call ids", () => {
    expect(isGraphModelId("graph:gr_28beee6b8bffe5a9")).toBe(true);
    expect(journalProviderRunId(graphUuid, "graph:gr_28beee6b8bffe5a9")).toBe(graphUuid);
    expect(journalProviderRunId(graphUuid, "gpt-6-luna")).toBeNull();
    expect(journalProviderRunId("run_chk1", "graph:gr_check")).toBe("run_chk1");
    expect(isGraphModelId("find_graph_decide")).toBe(true);
    expect(journalProviderRunId(graphUuid, "find_graph_decide")).toBe(graphUuid);
  });
});

describe("journalModelRunText", () => {
  const graphUuid = "a5c7d2ef-867b-418e-b8d1-e854e90f04be";
  it("labels the graph id and the run id separately for a graph step", () => {
    expect(journalModelRunText("graph:gr_28beee6b8bffe5a9", graphUuid)).toBe(
      `Graph id gr_28beee6b8bffe5a9 · run id ${graphUuid}`,
    );
    expect(journalModelRunText("graph:gr_28beee6b8bffe5a9", null)).toBe("Graph id gr_28beee6b8bffe5a9 · no run id");
    expect(graphIdFromModel("graph:gr_28beee6b8bffe5a9")).toBe("gr_28beee6b8bffe5a9");
    expect(graphIdFromModel("gpt-6-luna")).toBeNull();
  });

  it("keeps the model and response wording for non-graph steps", () => {
    expect(journalModelRunText("gpt-6-luna", "resp_abc123")).toBe("SERV · response resp_abc123");
    expect(journalModelRunText(["gpt-6", ".1-sol"].join(""), "resp_xyz")).toBe("SERV · response resp_xyz");
    expect(journalModelRunText(null, null)).toBe("Model not recorded · no response id");
  });
});
