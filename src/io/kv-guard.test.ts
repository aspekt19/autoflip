import { describe, expect, it } from "vitest";
import { moneyAuthStorageOk } from "./kv-guard";

describe("money/auth KV guard", () => {
  it("allows file/memory only off hosted runtimes", () => {
    expect(moneyAuthStorageOk({ NODE_ENV: "development" }, "file")).toBe(true);
    expect(moneyAuthStorageOk({ NODE_ENV: "test" }, "file")).toBe(true);
  });

  it("refuses file/memory on Vercel and production", () => {
    expect(moneyAuthStorageOk({ VERCEL: "1", VERCEL_ENV: "production" }, "file")).toBe(false);
    expect(moneyAuthStorageOk({ VERCEL: "1", VERCEL_ENV: "preview" }, "unconfigured")).toBe(false);
    expect(moneyAuthStorageOk({ NODE_ENV: "production" }, "file")).toBe(false);
    expect(moneyAuthStorageOk({ VERCEL: "1", VERCEL_ENV: "production" }, "upstash")).toBe(true);
    expect(moneyAuthStorageOk({ VERCEL: "1", VERCEL_ENV: "preview" }, "upstash")).toBe(true);
  });
});
