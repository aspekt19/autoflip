import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { getKv } from "@/io/kv";
import { createApiKey } from "@/server/api-keys";
import { createAgentResaleRun } from "@/server/agent-resale";
import { agentListRadarWatches, agentSaveRadarWatch } from "@/server/agent-radar";
import { toolList } from "@/server/mcp";

const dir = mkdtempSync(path.join(tmpdir(), "af-parity-"));

beforeAll(() => {
  process.env.AUTOFLIP_DATA_DIR = dir;
});

describe("agent resale + radar parity helpers", () => {
  it("exposes resale and radar tools alongside check/find", () => {
    const names = toolList().map((row) => row.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "check_car",
        "find_cars",
        "resale_search",
        "resale_status",
        "resale_result",
        "radar_watches",
        "radar_save_watch",
        "radar_check_now",
        "radar_feed",
        "deal_radar",
      ]),
    );
  });

  it("rejects resale without a budget", async () => {
    const kv = getKv();
    const created = await createApiKey(kv, "resale-user", "Resale");
    const caller = {
      userId: "resale-user",
      keyId: created.record.id,
      keyPrefix: created.record.prefix,
      keyHash: created.binding.apiKeyHash,
      scopes: ["read", "check", "find"] as ("read" | "check" | "find")[],
      token: created.token,
    };
    const out = await createAgentResaleRun(
      caller,
      {},
      {
        kv,
        origin: "http://localhost",
        fetch: async () => new Response("{}", { status: 500 }),
      },
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.status).toBe(400);
    expect((out.body as { error_code?: string }).error_code).toBe("missing_budget");
  });

  it("lists empty radar watches for a new owner", async () => {
    const kv = getKv();
    const created = await createApiKey(kv, "radar-user", "Radar");
    const caller = {
      userId: "radar-user",
      keyId: created.record.id,
      keyPrefix: created.record.prefix,
      keyHash: created.binding.apiKeyHash,
      scopes: ["read", "check", "find"] as ("read" | "check" | "find")[],
      token: created.token,
    };
    const listed = await agentListRadarWatches(caller, { kv, origin: "http://localhost" });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.body.watches).toEqual([]);
  });

  it("requires priceMax when saving a radar watch", async () => {
    const kv = getKv();
    const created = await createApiKey(kv, "radar-save-user", "Radar");
    const caller = {
      userId: "radar-save-user",
      keyId: created.record.id,
      keyPrefix: created.record.prefix,
      keyHash: created.binding.apiKeyHash,
      scopes: ["read", "check", "find"] as ("read" | "check" | "find")[],
      token: created.token,
    };
    const saved = await agentSaveRadarWatch(
      caller,
      { mode: "personal", criteria: { zip: "78701" } as never },
      { kv, origin: "http://localhost" },
    );
    expect(saved.ok).toBe(false);
    if (saved.ok) return;
    expect(saved.status).toBe(400);
    expect(saved.body.error_code).toBe("invalid_criteria");
  });
});
