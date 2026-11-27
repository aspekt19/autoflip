import { describe, expect, it, vi } from "vitest";
import { extractGraphTrail, findDecideGraphId, isGraphId, runServGraph } from "./graph";

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

const deps = { apiKey: "test-key", baseUrl: "https://serv.test/v1", timeoutMs: 5_000 };

describe("SERV graph call path", () => {
  it("sends the graph id as model, input in instructions, no stream and no feature suffix", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { id: "resp_graph1", output_text: '{"ok":true}', usage: { total_tokens: 10 } },
        { headers: { "x-openserv-request-id": "run_abc" } },
      ),
    );
    const result = await runServGraph({
      graphId: "gr_demo1",
      instructions: '{"facts":{}}',
      deps: { ...deps, fetch: fetchImpl as unknown as typeof fetch },
    });
    expect(result.ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://serv.test/v1/responses");
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({ model: "gr_demo1", instructions: '{"facts":{}}' });
    expect(body.stream).toBeUndefined();
    expect(body.model).not.toMatch(/-serv-/);
    expect(result.meta.runId).toBe("run_abc");
    expect(result.meta.responseId).toBe("resp_graph1");
    expect(result.meta.usage).toEqual({ total_tokens: 10 });
    if (result.ok) expect(result.text).toBe('{"ok":true}');
  });

  it("treats a function_call pause as a failure (the Find decide graph has no tools)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ id: "resp_x", output: [{ type: "function_call", name: "lookup", arguments: "{}", call_id: "c1" }] }),
    );
    const result = await runServGraph({
      graphId: "gr_demo1",
      instructions: "{}",
      deps: { ...deps, fetch: fetchImpl as unknown as typeof fetch },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.transportErrorClass).toBe("tool_call");
  });

  it("reports HTTP errors with their class and keeps the run id", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: "Graph not found" } }, { status: 404, headers: { "x-openserv-request-id": "run_404" } }),
    );
    const result = await runServGraph({
      graphId: "gr_gone",
      instructions: "{}",
      deps: { ...deps, fetch: fetchImpl as unknown as typeof fetch },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.transportErrorClass).toBe("http_4xx");
    expect(result.meta.runId).toBe("run_404");
    expect(result.meta.httpStatus).toBe(404);
  });

  it("reports a network failure without throwing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("fetch failed");
    });
    const result = await runServGraph({
      graphId: "gr_demo1",
      instructions: "{}",
      deps: { ...deps, fetch: fetchImpl as unknown as typeof fetch },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.transportErrorClass).toBe("network");
  });

  it("reads a step trail only when the body carries one", () => {
    expect(extractGraphTrail({ id: "r" })).toBeNull();
    expect(
      extractGraphTrail({ metadata: { steps: [{ id: "choose_action", kind: "decision", status: "completed" }] } }),
    ).toEqual([{ id: "choose_action", kind: "decision", status: "completed" }]);
  });

  it("accepts only gr_ ids from SERV_GRAPH_FIND_DECIDE_ID", () => {
    expect(isGraphId("gr_abc123")).toBe(true);
    expect(isGraphId("plain-model-id")).toBe(false);
    expect(findDecideGraphId({ SERV_GRAPH_FIND_DECIDE_ID: " gr_abc " })).toBe("gr_abc");
    expect(findDecideGraphId({ SERV_GRAPH_FIND_DECIDE_ID: "plain-model-id" })).toBeNull();
    expect(findDecideGraphId({})).toBeNull();
  });
});
