import { describe, expect, it } from "vitest";
import {
  SERV_OUTPUT_TOKEN_DEFAULT,
  SERV_OUTPUT_TOKEN_MAX,
  SERV_OUTPUT_TOKEN_MIN,
  resolveServOutputTokenBound,
  withServOutputTokenBound,
} from "./output-tokens";
import { requestFor, runServ } from "./run";
import { PROFILES, type ProfileId, type ServProfile } from "./profiles";

/**
 * Provider contract (OpenServ SERV Reasoning docs / working material):
 * - Chat completions → `max_completion_tokens`
 * - Responses API → `max_output_tokens`
 * TimeoutMs is independent; no USD guarantee is claimed from a token ceiling.
 */
describe("SERV output token bound (offline)", () => {
  it("defaults to a comfortable scout-sized ceiling when env unset", () => {
    expect(resolveServOutputTokenBound({})).toEqual({
      ok: true,
      tokens: SERV_OUTPUT_TOKEN_DEFAULT,
      source: "default",
    });
    expect(SERV_OUTPUT_TOKEN_DEFAULT).toBe(65_536);
    expect(SERV_OUTPUT_TOKEN_DEFAULT).toBeGreaterThanOrEqual(SERV_OUTPUT_TOKEN_MIN);
    expect(SERV_OUTPUT_TOKEN_DEFAULT).toBeLessThanOrEqual(SERV_OUTPUT_TOKEN_MAX);
  });

  it("accepts in-range env override", () => {
    expect(resolveServOutputTokenBound({ SERV_MAX_OUTPUT_TOKENS: "2048" })).toEqual({
      ok: true,
      tokens: 2048,
      source: "env",
    });
  });

  it("fail-closes on invalid / out-of-range env (does not dispatch unbounded)", () => {
    for (const raw of ["", "abc", "0", "12.5", "-1", "100", String(SERV_OUTPUT_TOKEN_MAX + 1)]) {
      const env = { SERV_MAX_OUTPUT_TOKENS: raw };
      // empty string is treated as unset → default
      if (raw === "") {
        expect(resolveServOutputTokenBound(env).ok).toBe(true);
        continue;
      }
      const bound = resolveServOutputTokenBound(env);
      expect(bound.ok).toBe(false);
      if (!bound.ok) expect(bound.message).toMatch(/SERV_MAX_OUTPUT_TOKENS/);
    }
  });

  it("maps provider-correct fields by endpoint", () => {
    const chat = withServOutputTokenBound("chat", { model: "gpt-5.4-mini" }, 4096);
    expect(chat).toEqual({ model: "gpt-5.4-mini", max_completion_tokens: 4096 });
    expect("max_output_tokens" in chat).toBe(false);

    const responses = withServOutputTokenBound("responses", { model: "gpt-5.4-mini" }, 4096);
    expect(responses).toEqual({ model: "gpt-5.4-mini", max_output_tokens: 4096 });
    expect("max_completion_tokens" in responses).toBe(false);
  });

  it("requestFor(find_plan) serializes exact chat bound field", () => {
    const req = requestFor("find_plan", JSON.stringify({ pendingVins: ["X"] }), undefined, {});
    expect(req.endpoint).toBe("chat");
    expect(PROFILES.find_plan.endpoint).toBe("chat");
    expect(req).toMatchObject({ max_completion_tokens: SERV_OUTPUT_TOKEN_DEFAULT });
    expect("max_output_tokens" in req).toBe(false);

    const serialized = JSON.stringify(req);
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    expect(parsed.max_completion_tokens).toBe(SERV_OUTPUT_TOKEN_DEFAULT);
    expect(parsed).not.toHaveProperty("max_output_tokens");
    // Schema + bound coexist (useful scout JSON fits under 4096).
    expect(parsed.response_format).toBeTruthy();
  });

  it("requestFor throws on invalid env (fail closed before HTTP)", () => {
    expect(() =>
      requestFor("find_plan", "{}", undefined, { SERV_MAX_OUTPUT_TOKENS: "999999" }),
    ).toThrow(/SERV_MAX_OUTPUT_TOKENS/);
  });

  it("runServ find_plan posts exact serialized max_completion_tokens on every HTTP (incl empty retry)", async () => {
    const bodies: string[] = [];
    let calls = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      bodies.push(String(init?.body ?? ""));
      calls += 1;
      // First empty → triggers postProse retry with same body.
      if (calls === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  type: "abstain",
                  reason: "insufficient evidence",
                  vin: null,
                  toolId: null,
                  args: null,
                  rationaleKind: null,
                  citedEvidence: null,
                  assumptionsDisclosed: null,
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const reservations: number[] = [];
    const result = await runServ(
      "find_plan",
      { user: JSON.stringify({ pendingVins: [] }) },
      {
        fetch: fetchImpl,
        apiKey: "test-key",
        baseUrl: "https://serv-mock.test/v1",
        env: { SERV_MAX_OUTPUT_TOKENS: "3072" },
        beforeHttp: async () => {
          reservations.push(1);
          return { ok: true };
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    expect(reservations.length).toBe(bodies.length);
    const parsedBodies = bodies.map((raw) => JSON.parse(raw) as Record<string, unknown>);
    expect(parsedBodies[0]?.max_completion_tokens).toBe(3072);
    expect(parsedBodies[1]?.max_completion_tokens).toBeGreaterThan(3072);
    for (const parsed of parsedBodies) {
      expect(parsed).not.toHaveProperty("max_output_tokens");
    }
  });

  it("runServ fails closed on invalid env without calling fetch or beforeHttp", async () => {
    let fetched = false;
    let reserved = false;
    const result = await runServ(
      "find_plan",
      { user: "{}" },
      {
        apiKey: "test-key",
        baseUrl: "https://serv-mock.test/v1",
        env: { SERV_MAX_OUTPUT_TOKENS: "nope" },
        fetch: async () => {
          fetched = true;
          return new Response("{}", { status: 500 });
        },
        beforeHttp: async () => {
          reserved = true;
          return { ok: true };
        },
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.upstream).toBe("output_token_bound_invalid");
      expect(result.error).toMatch(/SERV_MAX_OUTPUT_TOKENS/);
    }
    expect(fetched).toBe(false);
    expect(reserved).toBe(false);
  });

  it("application-tool responses finalize/follow body carries max_output_tokens", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let n = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      n += 1;
      if (n === 1) {
        return new Response(
          JSON.stringify({
            output: [
              {
                type: "function_call",
                call_id: "call_1",
                name: "read_computed_facts",
                arguments: '{"seen":true}',
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          output_text: "explanation text for the shopper",
          output: [{ type: "message", content: [{ type: "output_text", text: "explanation text for the shopper" }] }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const appToolProfiles = (Object.values(PROFILES) as ServProfile[]).filter((p) => Boolean(p.applicationTool));
    expect(appToolProfiles.length).toBeGreaterThan(0);
    const id = appToolProfiles[0]!.id as ProfileId;

    const result = await runServ(
      id,
      { user: "{}", facts: { a: 1 } },
      {
        fetch: fetchImpl,
        apiKey: "test-key",
        baseUrl: "https://serv-mock.test/v1",
        env: {},
      },
    );
    expect(result.ok).toBe(true);
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    for (const body of bodies) {
      expect(body.max_output_tokens).toBe(SERV_OUTPUT_TOKEN_DEFAULT);
      expect(body.reasoning_effort === "none" || (body.reasoning as { effort?: string } | undefined)?.effort === "none").toBe(
        false,
      );
    }
  });

  it("only applicationTool profiles declare endpoint responses", () => {
    const responsesProfiles = (Object.values(PROFILES) as ServProfile[]).filter(
      (p) => p.endpoint === "responses",
    );
    expect(responsesProfiles.length).toBeGreaterThan(0);
    expect(responsesProfiles.every((p) => Boolean(p.applicationTool))).toBe(true);
  });

  it("check_rules posts chat/completions with max_completion_tokens", async () => {
    const bodies: string[] = [];
    const urls: string[] = [];
    const result = await runServ(
      "check_rules",
      { user: "hello" },
      {
        apiKey: "test-key",
        baseUrl: "https://serv-mock.test/v1",
        env: { SERV_MAX_OUTPUT_TOKENS: "1024" },
        fetch: async (url, init) => {
          urls.push(String(url));
          bodies.push(String(init?.body ?? ""));
          return new Response(
            JSON.stringify({
              choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(urls[0]).toContain("/chat/completions");
    expect(bodies.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(bodies[0]!) as Record<string, unknown>;
    expect(parsed.max_completion_tokens).toBe(1024);
    expect(parsed).not.toHaveProperty("max_output_tokens");
  });
});
