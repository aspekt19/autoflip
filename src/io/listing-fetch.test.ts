import { describe, expect, it, vi } from "vitest";
import { fetchListingPage, isBlockedIpAddress, looksBlocked, publicFetchDenial } from "./listing-fetch";

const publicLookup = async () => ["93.184.216.34"];

describe("listing-fetch", () => {
  it("flags captcha / 403 as blocked", () => {
    expect(looksBlocked(403, "<html>ok</html>")).toBe(true);
    expect(looksBlocked(200, "<html>cf-browser-verification</html>")).toBe(true);
    expect(looksBlocked(200, "<html><body>2021 Toyota Camry</body></html>")).toBe(false);
  });

  it("returns blocked outcome without inventing HTML on 403", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("<html>Access Denied</html>", { status: 403, headers: { "content-type": "text/html" } }),
    );
    const result = await fetchListingPage("https://dealer.example/car", {
      fetch: fetchImpl as unknown as typeof fetch,
      lookup: publicLookup,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocked).toBe(true);
      expect(result.reason).toMatch(/blocked/i);
    }
  });

  it("returns html on a normal 200", async () => {
    const html = "<html><body><h1>2021 Toyota Camry</h1></body></html>";
    const fetchImpl = vi.fn(async () => new Response(html, { status: 200 }));
    const result = await fetchListingPage("https://dealer.example/car", {
      fetch: fetchImpl as unknown as typeof fetch,
      lookup: publicLookup,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.html).toContain("Toyota Camry");
  });

  it("refuses private, loopback, and metadata targets without fetching", async () => {
    expect(isBlockedIpAddress("127.0.0.1")).toBe(true);
    expect(isBlockedIpAddress("10.1.1.1")).toBe(true);
    expect(isBlockedIpAddress("192.168.1.8")).toBe(true);
    expect(isBlockedIpAddress("169.254.169.254")).toBe(true);
    expect(isBlockedIpAddress("::1")).toBe(true);
    expect(isBlockedIpAddress("::ffff:169.254.169.254")).toBe(true);
    expect(isBlockedIpAddress("93.184.216.34")).toBe(false);

    const fetchImpl = vi.fn();
    for (const url of [
      "http://127.0.0.1/latest/meta-data",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/",
      "http://localhost/admin",
      "http://2130706433/",
      "http://0177.0.0.1/",
      "file:///etc/passwd",
      "http://user:pass@dealer.example/car",
    ]) {
      const result = await fetchListingPage(url, { fetch: fetchImpl as unknown as typeof fetch, lookup: publicLookup });
      expect(result.ok, url).toBe(false);
      if (!result.ok) expect(result.reason.length, url).toBeGreaterThan(0);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not follow a redirect onto a private address", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("169.254.169.254") || url.includes("127.0.0.1")) {
        return new Response("secret", { status: 200 });
      }
      return new Response("", {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data" },
      });
    });
    const result = await fetchListingPage("https://dealer.example/car", {
      fetch: fetchImpl as unknown as typeof fetch,
      lookup: async (hostname) => (hostname === "dealer.example" ? ["93.184.216.34"] : ["169.254.169.254"]),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocked).toBe(true);
      expect(result.reason).toMatch(/not a public web page/i);
    }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).not.toContain("169.254");
  });

  it("refuses a public name that resolves to a private address", async () => {
    const fetchImpl = vi.fn();
    const denial = await publicFetchDenial(new URL("https://metadata.example/latest"), async () => ["169.254.169.254"]);
    expect(denial).toMatch(/not a public web page/i);
    const result = await fetchListingPage("https://metadata.example/latest", {
      fetch: fetchImpl as unknown as typeof fetch,
      lookup: async () => ["10.0.0.5"],
    });
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
