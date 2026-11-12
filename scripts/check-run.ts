/**
 * Check a published run against the same invariants the server uses.
 * Usage: npm run check:run -- <prod run url or id>...
 * Reads public GET /api/run/<id> JSON. No auth.
 */
import { checkRunInvariants } from "../src/domain/run-invariants";

const PROD = "https://autoflip-umber.vercel.app";

function idOf(token: string): string {
  const match = token.match(/run_[a-z0-9]{16,32}/i);
  if (!match) throw new Error(`Not a run url or id: ${token}`);
  return match[0]!;
}

async function main() {
  const tokens = process.argv.slice(2).filter((arg) => arg !== "--");
  if (!tokens.length) {
    console.error("Usage: npm run check:run -- <prod run url or id>...");
    process.exit(2);
  }
  let failed = 0;
  for (const token of tokens) {
    const id = idOf(token);
    const url = `${PROD}/api/run/${id}`;
    const pageUrl = `${PROD}/run/${id}`;
    const [response, page] = await Promise.all([fetch(url), fetch(pageUrl)]);
    const body = (await response.json()) as unknown;
    const html = await page.text();
    console.log(`\n${id}  ${response.status}  ${url}`);
    console.log(`  page  ${page.status}  ${pageUrl}`);
    if (!response.ok) {
      console.log(`  FAIL fetch  HTTP ${response.status}`);
      failed += 1;
      continue;
    }
    const report = checkRunInvariants(body, page.ok ? html : null);
    for (const check of report.checks) {
      console.log(`  ${check.pass ? "PASS" : "FAIL"} ${check.id}  ${check.message}`);
    }
    console.log(report.ok ? "  RESULT PASS" : "  RESULT FAIL");
    if (!report.ok) failed += 1;
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
