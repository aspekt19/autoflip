import { describe, expect, it } from "vitest";
import { MemoryKv } from "@/io/kv";
import {
  bindTelegram,
  saveTelegramCode,
  unlinkTelegram,
  telegramChat,
  telegramOwner,
} from "@/server/radar-store";
import {
  CODE_EXPIRED,
  CONNECT_HELP,
  LINK_TTL_MS,
  LINKED_TEXT,
  STOPPED_TEXT,
  httpsListingUrl,
  isStopCommand,
  mintTelegramLinkToken,
  parseStartCommand,
  radarAlertTelegramText,
  telegramDeepLink,
  verifyTelegramLinkToken,
  webhookAuthorized,
} from "./telegram";

describe("telegram linking", () => {
  it("mints and verifies a one-time signed start token", () => {
    const secret = "test-webhook-secret";
    const now = Date.parse("2026-11-13T12:00:00Z");
    const token = mintTelegramLinkToken("user-1", secret, now);
    expect(verifyTelegramLinkToken(token, secret, now + 1000)).toEqual({ ok: true, userId: "user-1" });
    expect(verifyTelegramLinkToken(token, secret, now + LINK_TTL_MS + 1).ok).toBe(false);
    expect(verifyTelegramLinkToken(token, "other", now + 1000).ok).toBe(false);
    expect(telegramDeepLink("@autoflip_radar_bot", token)).toContain(
      "https://t.me/autoflip_radar_bot?start=",
    );
  });

  it("parses /start token and /stop unlink", () => {
    expect(parseStartCommand("/start abcdef12xyz")).toBe("abcdef12xyz");
    expect(isStopCommand("/stop")).toBe(true);
    expect(isStopCommand("/stop@autoflip_radar_bot")).toBe(true);
    expect(CONNECT_HELP).toMatch(/\/stop/);
    expect(LINKED_TEXT).toMatch(/Lemonless Radar/);
    expect(STOPPED_TEXT).toMatch(/unlinked/i);
  });

  it("links and unlinks chat id via KV", async () => {
    const kv = new MemoryKv();
    const now = Date.parse("2026-11-13T12:00:00Z");
    await saveTelegramCode(kv, "code-one", "user-1", now);
    const linked = await bindTelegram(kv, "code-one", "999", now + 1000);
    expect(linked).toEqual({ ok: true, ownerId: "user-1" });
    expect(await telegramChat(kv, "user-1")).toBe("999");
    expect(await telegramOwner(kv, "999")).toBe("user-1");
    const reused = await bindTelegram(kv, "code-one", "999", now + 2000);
    expect(reused).toEqual({ ok: false, reason: "used" });

    await saveTelegramCode(kv, "code-exp", "user-1", now);
    const expired = await bindTelegram(kv, "code-exp", "111", now + LINK_TTL_MS + 1);
    expect(expired).toEqual({ ok: false, reason: "expired" });
    expect(CODE_EXPIRED).toMatch(/15 minutes/);

    await unlinkTelegram(kv, "user-1", "999");
    expect(await telegramChat(kv, "user-1")).toBeNull();
    expect(await telegramOwner(kv, "999")).toBeNull();
  });

  it("builds alert text with https listing URL and report link", () => {
    const text = radarAlertTelegramText({
      year: 2018,
      make: "Toyota",
      model: "Camry",
      priceUsd: 14_500,
      miles: 62_000,
      distanceMiles: 42,
      listingUrl: "https://dealer.example/cars/camry",
      reportUrl: "https://lemonless.example/radar#alert-abc",
      searchName: "Camry near Austin",
    });
    expect(text).toMatch(/2018 Toyota Camry/);
    expect(text).toMatch(/\$14,500/);
    expect(text).toMatch(/62,000 mi/);
    expect(text).toMatch(/42 mi away/);
    expect(text).toContain("https://dealer.example/cars/camry");
    expect(text).toContain("https://lemonless.example/radar#alert-abc");
    expect(httpsListingUrl("http://insecure.example/x")).toBeNull();
    expect(httpsListingUrl("https://ok.example/x")).toBe("https://ok.example/x");
  });

  it("accepts only the matching webhook secret", () => {
    expect(webhookAuthorized("secret-token", "secret-token")).toBe(true);
    expect(webhookAuthorized("other", "secret-token")).toBe(false);
    expect(webhookAuthorized(null, "secret-token")).toBe(false);
  });
});
