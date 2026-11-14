import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assembleReport: vi.fn(),
  persistReport: vi.fn(),
  agentReport: vi.fn(),
}));

vi.mock("@/server/assemble", () => ({ assembleReport: mocks.assembleReport }));
vi.mock("@/io/persist-report", () => ({ persistReport: mocks.persistReport }));
vi.mock("@/server/agent-report", () => ({ agentReport: mocks.agentReport }));

import { creditBalance, creditGrant } from "@/io/credit-book";
import { getKv } from "@/io/kv";
import { createApiKey } from "@/server/api-keys";
import { POST } from "./route";

const USER = "report-route-user";
const VIN = "1HGCM82633A004352";

beforeEach(() => {
  process.env.AUTOFLIP_DATA_DIR = mkdtempSync(path.join(tmpdir(), "af-v1-report-"));
  vi.clearAllMocks();
  mocks.assembleReport.mockResolvedValue({ ok: true, report: { id: "report-test" } });
  mocks.persistReport.mockResolvedValue(undefined);
  mocks.agentReport.mockReturnValue({ id: "report-test", verdict: "fair" });
});

function request(token: string) {
  return new Request("https://lemonless.test/api/v1/report", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": "same-report-request",
    },
    body: JSON.stringify({ vin: VIN }),
  });
}

describe("POST /api/v1/report", () => {
  it("enforces the check scope on API keys", async () => {
    const kv = getKv();
    await creditGrant(kv, USER, 2, "seed-read-only");
    const key = await createApiKey(kv, USER, "Read only", ["read"]);

    const response = await POST(request(key.token));

    expect(response.status).toBe(403);
    expect((await response.json()).error_code).toBe("missing_scope");
    expect(mocks.assembleReport).not.toHaveBeenCalled();
    expect(await creditBalance(kv, USER)).toBe(2);
  });

  it("does not spend a credit when report persistence fails", async () => {
    const kv = getKv();
    await creditGrant(kv, USER, 1, "seed-persist-failure");
    const key = await createApiKey(kv, USER, "Report", ["check"]);
    mocks.persistReport.mockRejectedValueOnce(new Error("persist_failed"));

    await expect(POST(request(key.token))).rejects.toThrow("persist_failed");
    expect(await creditBalance(kv, USER)).toBe(1);
  });

  it("persists before spending and returns rate-limit headers", async () => {
    const kv = getKv();
    await creditGrant(kv, USER, 1, "seed-success");
    const key = await createApiKey(kv, USER, "Report", ["check"]);
    let balanceAtPersist: number | null = null;
    mocks.persistReport.mockImplementationOnce(async () => {
      balanceAtPersist = await creditBalance(kv, USER);
    });

    const response = await POST(request(key.token));

    expect(response.status).toBe(200);
    expect(balanceAtPersist).toBe(1);
    expect(await creditBalance(kv, USER)).toBe(0);
    expect(response.headers.get("X-RateLimit-Limit")).toBe("30");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("29");
  });
});
