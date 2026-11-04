import { describe, expect, it } from "vitest";
import { alertMessage, parseSkipCallback, parseStartCommand, telegramDeepLink, webhookAuthorized } from "./telegram";

describe("telegram linking", () => {
  it("parses a start code and ignores a bare start", () => {
    expect(parseStartCommand("/start abcdef12")).toBe("abcdef12");
    expect(parseStartCommand("/start@AutoFlipBot abcdef12")).toBe("abcdef12");
    expect(parseStartCommand("/start")).toBeNull();
    expect(parseStartCommand("hello")).toBeNull();
  });

  it("builds the deep link and the alert keyboard", () => {
    expect(telegramDeepLink("@autoflip_bot", "abc12345")).toBe("https://t.me/autoflip_bot?start=abc12345");
    const message = alertMessage({ why: "2016 Toyota RAV4 · $16,900 · Miami, FL.", origin: "https://autoflip.example", alertId: "11111111-1111-1111-1111-111111111111" });
    expect(message.reply_markup.inline_keyboard[0]?.[0]?.url).toContain("/radar?alert=");
    expect(message.reply_markup.inline_keyboard[0]?.[1]?.callback_data).toMatch(/^skip:/);
    expect(parseSkipCallback("skip:11111111-1111-1111-1111-111111111111")).toBe("11111111-1111-1111-1111-111111111111");
    expect(parseSkipCallback("nope")).toBeNull();
  });

  it("accepts only the matching webhook secret", () => {
    expect(webhookAuthorized("secret-token", "secret-token")).toBe(true);
    expect(webhookAuthorized("other", "secret-token")).toBe(false);
    expect(webhookAuthorized(null, "secret-token")).toBe(false);
    expect(webhookAuthorized("secret-token", "")).toBe(false);
  });
});
