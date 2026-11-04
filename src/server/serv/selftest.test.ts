import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/serv/selftest/route";
import { PROFILES } from "./profiles";
import { distinctSelftestProfiles } from "./selftest";

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
});
