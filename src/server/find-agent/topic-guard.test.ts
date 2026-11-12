import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SERV_TOPIC_SCOPE_RULE } from "@/domain/shopper-brief";

describe("topic guard lives in SERV instructions (code does not classify)", () => {
  it("Find + Resale loop prompts include the scope rule", () => {
    const find = readFileSync(join(process.cwd(), "src/server/find-agent/loop.ts"), "utf8");
    const resale = readFileSync(join(process.cwd(), "src/server/resale-agent/loop.ts"), "utf8");
    expect(find).toMatch(/SERV_TOPIC_SCOPE_RULE/);
    expect(resale).toMatch(/SERV_TOPIC_SCOPE_RULE/);
    expect(SERV_TOPIC_SCOPE_RULE).toMatch(/do not call tools/i);
  });

  it("chat routes do not reject off-topic by keyword", () => {
    const findChat = readFileSync(join(process.cwd(), "src/server/find-chat.ts"), "utf8");
    const resaleChat = readFileSync(join(process.cwd(), "src/server/resale-chat.ts"), "utf8");
    expect(findChat).not.toMatch(/off[- ]?topic|bannedTopics|isOnTopic/i);
    expect(resaleChat).not.toMatch(/off[- ]?topic|bannedTopics|isOnTopic/i);
    expect(findChat).toMatch(/chatLimitViolation/);
    expect(resaleChat).toMatch(/chatLimitViolation/);
  });
});
