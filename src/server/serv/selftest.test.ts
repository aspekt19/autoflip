import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/serv/selftest/route";
import { profile, PROFILES, type ProfileId } from "./profiles";
import type { ServDeps, ServResult } from "./run";
import { distinctSelftestProfiles, HOBBY_FUNCTION_MS, runSelftestChecks, selftestRepeat, selftestWallClockMs } from "./selftest";

describe("SERV self-test", () => {
  it("covers each distinct request shape once", () => {
    const ids = distinctSelftestProfiles();
    expect(ids.length).toBeGreaterThanOrEqual(6);
    expect(ids.length).toBeLessThan(Object.keys(PROFILES).length);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("flip_judge");
    expect(ids).toContain("check_rules");
    expect(ids).toContain("telegram_reply");
    expect(ids).toContain("need_extract");
    expect(ids).toContain("find_plan");
  });

  it("rejects a missing or wrong bearer secret without calling the model", async () => {
    const previousSecret = process.env.RADAR_CRON_SECRET;
    const previousKey = process.env.SERV_API_KEY;
    delete process.env.RADAR_CRON_SECRET;
    const missing = await GET(new Request("http://localhost/api/serv/selftest"));
    expect(missing.status).toBe(503);
    process.env.RADAR_CRON_SECRET = "cron-test";
    const wrong = await GET(new Request("http://localhost/api/serv/selftest", { headers: { authorization: "Bearer no" } }));
    expect(wrong.status).toBe(401);
    delete process.env.SERV_API_KEY;
    const noModel = await GET(new Request("http://localhost/api/serv/selftest", { headers: { authorization: "Bearer cron-test" } }));
    expect(noModel.status).toBe(503);
    if (previousSecret === undefined) delete process.env.RADAR_CRON_SECRET;
    else process.env.RADAR_CRON_SECRET = previousSecret;
    if (previousKey === undefined) delete process.env.SERV_API_KEY;
    else process.env.SERV_API_KEY = previousKey;
  });

  it("uses each profile timeout, never a 6s clamp, and stays inside the Hobby limit in parallel", async () => {
    const seen: Array<{ id: ProfileId; deps: ServDeps }> = [];
    const run = async (id: ProfileId, _input: { user: string; facts?: unknown }, deps: ServDeps): Promise<ServResult> => {
      seen.push({ id, deps });
      const timeout = profile(id).timeoutMs;
      return {
        ok: false,
        error: "SERV did not respond.",
        status: 0,
        fallback: "explanation unavailable",
        proof: {
          purpose: id,
          modelRequested: "gpt-5.4-mini",
          modelReported: "gpt-5.4-mini",
          tools: [],
          features: [],
          promptGuard: "unavailable",
          shadowOutcome: "not_used",
          shadowMaxIterations: null,
          latencyMs: timeout + 2,
          reasoningEffort: null,
          contentFilter: "default_on",
          promptCache: "default",
          streamed: false,
          endpoint: "chat",
          applicationTool: null,
          jsonSchema: null,
          codeComputed: [],
          fallbackUsed: true,
          openserv: null,
        },
        httpAttempts: 0,
        transportPolicy: "production",
        responseShape: null,
      };
    };
    const checks = await runSelftestChecks({ apiKey: "test-key" }, run);
    expect(seen.length).toBe(distinctSelftestProfiles().length);
    for (const call of seen) {
      expect(call.deps.timeoutMs).toBeUndefined();
      expect(call.deps.apiKey).toBe("test-key");
    }
    for (const check of checks) {
      expect(check.timeoutMs).toBe(profile(check.profile).timeoutMs);
      expect(check.timeoutMs).toBeGreaterThan(6_000);
      expect(check.latencyMs).toBeLessThan(check.timeoutMs);
      expect(check.withinTimeout).toBe(true);
    }
    expect(selftestWallClockMs()).toBeLessThan(HOBBY_FUNCTION_MS);
    expect(selftestWallClockMs()).toBe(profile("report_explain").timeoutMs * 2);
  });

  it("repeats each profile in parallel and scores a 95 percent pass rate", async () => {
    expect(selftestRepeat("3")).toBe(3);
    expect(selftestRepeat("5")).toBe(5);
    expect(selftestRepeat("9")).toBe(5);
    expect(selftestWallClockMs()).toBeLessThan(HOBBY_FUNCTION_MS);
    expect(selftestRepeat("no")).toBe(1);
    const counts = new Map<string, number>();
    const run = async (id: ProfileId): Promise<ServResult> => {
      const n = (counts.get(id) ?? 0) + 1;
      counts.set(id, n);
      const proof: ServResult extends { proof: infer P } ? P : never = {
        purpose: id,
        modelRequested: "gpt-5.4-mini",
        modelReported: "gpt-5.4-mini",
        tools: [],
        features: [],
        promptGuard: "unavailable",
        shadowOutcome: "not_used",
        shadowMaxIterations: null,
        latencyMs: 1,
        reasoningEffort: null,
        contentFilter: "default_on",
        promptCache: "default",
        streamed: false,
        endpoint: "chat",
        applicationTool: null,
        jsonSchema: null,
        codeComputed: [],
        fallbackUsed: n === 1,
        openserv: null,
      };
      if (n === 1) {
        return {
          ok: false,
          error: "SERV returned an empty explanation.",
          status: 200,
          fallback: "explanation unavailable",
          upstream: null,
          proof,
          httpAttempts: 1,
          transportPolicy: "production",
          responseShape: null,
        };
      }
      return {
        ok: true,
        text: "ok",
        model: "gpt-5.4-mini",
        shadowOutcome: "not_used",
        rawStatus: 200,
        proof,
        httpAttempts: 1,
        transportPolicy: "production",
        responseShape: null,
      };
    };
    const checks = await runSelftestChecks({ apiKey: "test-key", repeat: 3 }, run);
    expect(checks).toHaveLength(distinctSelftestProfiles().length);
    expect([...counts.values()].every((count) => count === 3)).toBe(true);
    let inFlight = 0;
    let maxInFlight = 0;
    const parallel = async (id: ProfileId): Promise<ServResult> => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return run(id);
    };
    await runSelftestChecks({ apiKey: "test-key", repeat: 5 }, parallel);
    expect(maxInFlight).toBe(distinctSelftestProfiles().length * 5);
    for (const check of checks) {
      expect(check.runs).toBe(3);
      expect(check.passes).toBe(2);
      expect(check.passRate).toBeCloseTo(2 / 3);
      expect(check.ok).toBe(false);
      expect(check.attempts).toHaveLength(3);
    }
  });
});
