#!/usr/bin/env node
/**
 * Fail-closed production source import boundary.
 * Exit 0 only after a complete scan with zero offenders.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  scanProductionSources,
  assertScanOk,
} from "./openserv-boundary.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

try {
  const result = scanProductionSources(root);
  assertScanOk(result, "production-source-boundary");
  console.log(
    `OK: production source boundary clean (${result.filesScanned} files; allowlisted=${result.allowed.join(",")})`,
  );
  process.exit(0);
} catch (err) {
  console.error("FAIL: production source boundary");
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
