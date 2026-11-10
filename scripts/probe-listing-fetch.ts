/**
 * Offline probe: which fixture listing URLs can our server fetcher read today?
 * Not wired into CI — run manually: npm run probe:listing-fetch
 *
 * Overwrites fixtures/listing-urls/probe-results.json with measured data only.
 * Never invents status codes or extraction results.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseListingHtml } from "../src/domain/listing/parse-html";
import type { ExtractedListingFields } from "../src/domain/listing/types";
import { fetchListingPage } from "../src/io/listing-fetch";

const ROOT = process.cwd();
const SITES_PATH = join(ROOT, "fixtures/listing-urls/sites.json");
const OUT_PATH = join(ROOT, "fixtures/listing-urls/probe-results.json");

type SiteEntry = {
  id: string;
  site: string;
  label: string;
  url: string;
};

function fieldSummary(fields: ExtractedListingFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(fields) as Array<keyof ExtractedListingFields>) {
    const row = fields[key];
    if (row.value == null) continue;
    out[key] = { value: row.value, source: row.source };
  }
  return out;
}

async function main() {
  const catalog = JSON.parse(readFileSync(SITES_PATH, "utf8")) as { sites: SiteEntry[] };
  const ranAt = new Date().toISOString();
  const results: Array<Record<string, unknown>> = [];

  for (const entry of catalog.sites) {
    process.stderr.write(`probe ${entry.id}… `);
    const started = Date.now();
    const fetched = await fetchListingPage(entry.url);
    const elapsedMs = Date.now() - started;

    if (!fetched.ok) {
      results.push({
        id: entry.id,
        site: entry.site,
        label: entry.label,
        url: entry.url,
        ok: false,
        blocked: fetched.blocked,
        status: fetched.status,
        bytes: null,
        reason: fetched.reason,
        elapsedMs,
        extracted: null,
      });
      process.stderr.write(`blocked/fail status=${fetched.status ?? "n/a"}\n`);
      continue;
    }

    const parse = parseListingHtml(fetched.html, fetched.finalUrl || fetched.url);
    const extracted = fieldSummary(parse.deterministic);
    results.push({
      id: entry.id,
      site: entry.site,
      label: entry.label,
      url: entry.url,
      finalUrl: fetched.finalUrl,
      ok: true,
      blocked: false,
      status: fetched.status,
      bytes: Buffer.byteLength(fetched.html, "utf8"),
      reason: null,
      elapsedMs,
      title: parse.title,
      extracted,
      extractedFieldCount: Object.keys(extracted).length,
    });
    process.stderr.write(`ok status=${fetched.status} bytes=${Buffer.byteLength(fetched.html, "utf8")}\n`);
  }

  const payload = {
    status: "ran",
    note: "Measured by scripts/probe-listing-fetch.ts against fixtures/listing-urls/sites.json using the production fetcher + deterministic parser (no LLM).",
    ranAt,
    results,
  };
  writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  process.stderr.write(`Wrote ${OUT_PATH} (${results.length} rows)\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
