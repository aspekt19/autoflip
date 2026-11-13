import { describe, expect, it } from "vitest";
import { toolList } from "./mcp";

describe("MCP public payment discovery", () => {
  it("advertises get_payment_info as a free, read-only tool", () => {
    const tool = toolList().find((item) => item.name === "get_payment_info");
    expect(tool).toBeDefined();
    expect(tool).toMatchObject({
      name: "get_payment_info",
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: { type: "object", properties: {} },
    });
  });
});
