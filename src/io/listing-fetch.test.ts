import { describe, expect, it, vi } from "vitest";
import { fetchListingPage, looksBlocked } from "./listing-fetch";

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
    const result = await fetchListingPage("https://dealer.example/car", { fetch: fetchImpl as unknown as typeof fetch });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocked).toBe(true);
      expect(result.reason).toMatch(/blocked/i);
    }
  });

  it("returns html on a normal 200", async () => {
    const html = "<html><body><h1>2021 Toyota Camry</h1></body></html>";
    const fetchImpl = vi.fn(async () => new Response(html, { status: 200 }));
    const result = await fetchListingPage("https://dealer.example/car", { fetch: fetchImpl as unknown as typeof fetch });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.html).toContain("Toyota Camry");
  });
});
