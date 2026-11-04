import { describe, expect, it } from "vitest";
import { MemoryKv } from "@/io/kv";
import { findUserReport, rememberUserReport } from "@/io/persist-report";
import { bindTelegram, saveTelegramCode, setTelegramPaused, telegramPaused } from "@/server/radar-store";
import {
  CODE_EXPIRED,
  CODE_USED,
  CONNECT_HELP,
  LINK_TTL_MS,
  PAUSED_TEXT,
  REPORT_FAILED_TEXT,
  RESUMED_TEXT,
  alertMessage,
  alertText,
  helpKeyboard,
  isBareStart,
  isHelpCommand,
  isPauseCommand,
  isResumeCommand,
  isSearchesCommand,
  parsePauseCallback,
  parseSkipCallback,
  parseStartCommand,
  reportReadyMessage,
  telegramDeepLink,
  webhookAuthorized,
  type AlertCopy,
} from "./telegram";

const base: AlertCopy = {
  searchName: "RAV4 nearby",
  mode: "personal",
  year: 2016,
  make: "Toyota",
  model: "RAV4",
  priceUsd: 16900,
  miles: 90000,
  city: "Miami",
  state: "FL",
  priceDropFrom: null,
  budgetUsd: 18000,
  radiusMiles: 100,
  zip: "33101",
  yearMin: 2014,
  yearMax: 2019,
  milesMax: null,
  bodyStyle: null,
  belowTypical: false,
  origin: "https://autoflip.example",
  alertId: "11111111-1111-1111-1111-111111111111",
};

describe("telegram linking", () => {
  it("parses commands and describes connect, pause, and searches", () => {
    expect(parseStartCommand("/start abcdef12")).toBe("abcdef12");
    expect(parseStartCommand("/start@AutoFlipBot abcdef12")).toBe("abcdef12");
    expect(isBareStart("/start")).toBe(true);
    expect(isBareStart("/start abcdef12")).toBe(false);
    expect(isHelpCommand("/help")).toBe(true);
    expect(isSearchesCommand("/searches")).toBe(true);
    expect(isPauseCommand("/pause")).toBe(true);
    expect(isResumeCommand("/resume@AutoFlipBot")).toBe(true);
    expect(parsePauseCallback("pause")).toBe("pause");
    expect(parsePauseCallback("skip:x")).toBeNull();
    expect(CONNECT_HELP).toMatch(/\/pause/);
    expect(CONNECT_HELP).toMatch(/15 minutes/);
    expect(CONNECT_HELP).not.toMatch(/openserv|hackathon|gpt-/i);
    expect(PAUSED_TEXT).toMatch(/unchanged/);
    expect(RESUMED_TEXT).toMatch(/on again/);
  });

  it("expires a connect code after 15 minutes and deletes it after one use", async () => {
    const kv = new MemoryKv();
    const now = Date.parse("2026-11-04T12:00:00Z");
    await saveTelegramCode(kv, "abcdef12", "user-1", now);
    const expired = await bindTelegram(kv, "abcdef12", "99", now + LINK_TTL_MS + 1);
    expect(expired).toEqual({ ok: false, reason: "expired" });
    expect(CODE_EXPIRED).toMatch(/15 minutes/);
    await saveTelegramCode(kv, "abcdef12", "user-1", now);
    const first = await bindTelegram(kv, "abcdef12", "99", now + 1000);
    expect(first).toEqual({ ok: true, ownerId: "user-1" });
    const second = await bindTelegram(kv, "abcdef12", "99", now + 2000);
    expect(second).toEqual({ ok: false, reason: "used" });
    expect(CODE_USED).toMatch(/already used/);
  });

  it("builds view, confirm, and hide buttons without a paid call", () => {
    expect(telegramDeepLink("@autoflip_bot", "abc12345")).toBe("https://t.me/autoflip_bot?start=abc12345");
    const message = alertMessage(base);
    const buttons = message.reply_markup.inline_keyboard.flat();
    const view = buttons.find((item) => item.text === "View in AutoFlip");
    const full = buttons.find((item) => item.text === "Full analysis — 1 credit");
    const hide = buttons.find((item) => item.text === "Not for me");
    expect(view?.url).toBe("https://autoflip.example/radar#alert-11111111-1111-1111-1111-111111111111");
    expect(view?.url).not.toMatch(/\/api\/report/);
    expect(full?.url).toContain("/radar?confirm=");
    expect(full?.url).not.toMatch(/\/api\/report/);
    expect(hide?.callback_data).toMatch(/^skip:/);
    expect(parseSkipCallback(hide?.callback_data ?? "")).toBe(base.alertId);
    expect(helpKeyboard("https://autoflip.example", true).inline_keyboard[1]?.[0]?.text).toBe("Resume alerts");
  });

  it("lists only known match facts and does not promise a flip profit", () => {
    const personal = alertText({ ...base, priceDropFrom: 18000, bodyStyle: null, milesMax: null });
    expect(personal).toMatch(/Saved search: RAV4 nearby/);
    expect(personal).toMatch(/2016 Toyota RAV4/);
    expect(personal).toMatch(/\$16,900/);
    expect(personal).toMatch(/90,000 mi/);
    expect(personal).toMatch(/Miami, FL/);
    expect(personal).toMatch(/Why it matched/);
    expect(personal).toMatch(/\$18,000 budget/);
    expect(personal).toMatch(/100 miles of 33101/);
    expect(personal).toMatch(/Price dropped from \$18,000/);
    expect(personal).toMatch(/preliminary match/);
    expect(personal).not.toMatch(/Body type/);

    const flip = alertText({
      ...base,
      mode: "flip",
      searchName: "Miami budget",
      belowTypical: false,
      yearMin: null,
      yearMax: null,
    });
    expect(flip).toMatch(/Worth a look/);
    expect(flip).not.toMatch(/Below the typical range/);
    expect(flip).not.toMatch(/\bprofit\b/i);
    expect(flip).toMatch(/Fees, repairs, and history still need checking/);
    const supported = alertText({ ...base, mode: "flip", belowTypical: true });
    expect(supported).toMatch(/Below the typical range of comparable listings/);
    expect(supported).not.toMatch(/\bprofit\b/i);
  });

  it("pauses Telegram delivery without removing the saved search flag", async () => {
    const kv = new MemoryKv();
    expect(await telegramPaused(kv, "user-1")).toBe(false);
    await setTelegramPaused(kv, "user-1", true);
    expect(await telegramPaused(kv, "user-1")).toBe(true);
    await setTelegramPaused(kv, "user-1", false);
    expect(await telegramPaused(kv, "user-1")).toBe(false);
  });

  it("builds the report-ready note and does not charge a saved VIN again", async () => {
    const ready = reportReadyMessage({
      car: "2016 Toyota RAV4",
      recommendation: "The asking price is low versus the comparable listings we could use.",
      origin: "https://autoflip.example/",
      reportId: "report-1",
    });
    expect(ready.text).toMatch(/✅ Report ready — 2016 Toyota RAV4/);
    expect(ready.text).toMatch(/Used 1 credit/);
    expect(ready.reply_markup.inline_keyboard[0]?.[0]?.url).toBe("https://autoflip.example/report/report-1");
    expect(REPORT_FAILED_TEXT).toMatch(/No credit was used/);
    const kv = new MemoryKv();
    const vin = "4T1KZ1AK4MU060006";
    expect(await findUserReport(kv, "user-1", vin)).toBeNull();
    await rememberUserReport(kv, "user-1", vin, "report-1");
    await kv.set("report:report-1", "{}");
    expect(await findUserReport(kv, "user-1", vin)).toBe("report-1");
    expect(ready.text).not.toMatch(/openserv|hackathon|gpt-/i);
  });

  it("accepts only the matching webhook secret", () => {
    expect(webhookAuthorized("secret-token", "secret-token")).toBe(true);
    expect(webhookAuthorized("other", "secret-token")).toBe(false);
    expect(webhookAuthorized(null, "secret-token")).toBe(false);
    expect(webhookAuthorized("secret-token", "")).toBe(false);
  });
});
