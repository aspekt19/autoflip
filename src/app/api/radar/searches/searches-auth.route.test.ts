/**
 * Deal Radar saved searches require a verified Auth.js account.
 * Anonymous af_uid cookies must not create watches.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryKv } from "@/io/kv";
import { listSearches } from "@/server/radar-store";

const ACCOUNT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

const kvHolder: { kv: MemoryKv } = { kv: new MemoryKv() };
const requireRadar = vi.fn();

vi.mock("@/server/session", () => ({
  requireVerifiedAccountForRadar: () => requireRadar(),
  ledgerOwnerId: async () => "should-not-be-used",
  isDemoUser: () => false,
}));

vi.mock("@/io/kv", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/io/kv")>();
  return { ...actual, getKv: () => kvHolder.kv };
});

vi.mock("@/domain/product-flags", () => ({
  resolveProductFlags: () => ({ resaleEvaluate: true, dealRadar: true, scout: false, telegram: false }),
  productFlagsUnavailableMessage: () => "unavailable",
}));

vi.mock("@/server/plan-book", () => ({
  allowance: async () => ({ ok: true }),
}));

import { POST } from "./route";

function req(body: unknown) {
  return new Request("https://lemonless.test/api/radar/searches", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID = {
  name: "Family SUV",
  mode: "personal",
  criteria: {
    zip: "33101",
    priceMax: 20_000,
    radiusMiles: 50,
    make: "Toyota",
    model: "RAV4",
  },
};

describe("POST /api/radar/searches verified-auth", () => {
  beforeEach(() => {
    kvHolder.kv = new MemoryKv();
    requireRadar.mockReset();
  });

  it("denies saving a watch without verified auth (no anonymous create)", async () => {
    requireRadar.mockResolvedValue({
      ok: false,
      response: Response.json({ error: "auth_required", message: "Sign in required." }, { status: 401 }),
    });
    const res = await POST(req(VALID));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("auth_required");
    expect(await listSearches(kvHolder.kv)).toEqual([]);
  });

  it("creates a saved search for a verified account", async () => {
    requireRadar.mockResolvedValue({ ok: true, id: ACCOUNT, email: "radar@example.com" });
    const res = await POST(req(VALID));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean };
    expect(body.ok).toBe(true);
    const searches = await listSearches(kvHolder.kv);
    expect(searches).toHaveLength(1);
    expect(searches[0]?.ownerId).toBe(ACCOUNT);
    expect(searches[0]?.preset).toBe(false);
    expect(searches[0]?.name).toBe("Family SUV");
  });
});
