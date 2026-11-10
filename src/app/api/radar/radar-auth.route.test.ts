/**
 * All Deal Radar user routes require a verified Auth.js account.
 * Anonymous af_uid cookies must not scan, read feed, or check-now.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const requireRadar = vi.fn();

vi.mock("@/server/session", () => ({
  requireVerifiedAccountForRadar: () => requireRadar(),
  ledgerOwnerId: async () => "should-not-be-used",
  isDemoUser: () => false,
}));

vi.mock("@/server/assemble", () => ({
  assembleRadar: vi.fn(async () => {
    throw new Error("assembleRadar must not run without verified auth");
  }),
}));

vi.mock("@/server/deps", () => ({
  runtimeDeps: () => ({}),
}));

vi.mock("@/io/kv", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/io/kv")>();
  return {
    ...actual,
    getKv: () => {
      throw new Error("getKv must not run without verified auth");
    },
    storageMode: () => "memory",
  };
});

vi.mock("@/server/radar-store", () => ({
  listSearches: async () => [],
  listAlerts: async () => [],
  listRuns: async () => [],
  seenVins: async () => new Set(),
  lastCheckNow: async () => null,
  markCheckNow: async () => undefined,
}));

vi.mock("@/server/radar-cycle", () => ({
  runRadarCycle: async () => {
    throw new Error("runRadarCycle must not run without verified auth");
  },
}));

import { POST as postScan } from "./route";
import { GET as getFeed } from "./feed/route";
import { POST as postCheck } from "./check/route";
import { GET as getActivity } from "./activity/route";
import { POST as postSkip } from "./skip/route";

function deny() {
  return {
    ok: false as const,
    response: Response.json({ error: "auth_required", message: "Sign in required." }, { status: 401 }),
  };
}

describe("Deal Radar verified-auth gates", () => {
  beforeEach(() => {
    requireRadar.mockReset();
    requireRadar.mockImplementation(async () => deny());
  });

  it("denies POST /api/radar without verified auth (no anonymous live scan)", async () => {
    const res = await postScan(
      new Request("https://lemonless.test/api/radar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ make: "Toyota", model: "Camry", zip: "33101" }),
      }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("auth_required");
  });

  it("denies GET /api/radar/feed without verified auth", async () => {
    const res = await getFeed();
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("auth_required");
  });

  it("denies POST /api/radar/check without verified auth", async () => {
    const res = await postCheck(new Request("https://lemonless.test/api/radar/check", { method: "POST" }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("auth_required");
  });

  it("denies GET /api/radar/activity without verified auth", async () => {
    const res = await getActivity();
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("auth_required");
  });

  it("denies POST /api/radar/skip without verified auth", async () => {
    const res = await postSkip(
      new Request("https://lemonless.test/api/radar/skip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alertId: "a1" }),
      }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("auth_required");
  });
});
