#!/usr/bin/env node
/**
 * Fail-closed .next/server reachability check for OpenServ SDK markers.
 * Portable Node only — does not depend on ripgrep.
 * Exit 0 only after a complete scan with zero offenders.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  scanNextServerForOpenServ,
  assertScanOk,
} from "./openserv-boundary.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const nextServer = join(root, ".next", "server");

try {
  const result = scanNextServerForOpenServ(root, nextServer);
  assertScanOk(result, "next-server-openserv-reachability");
  console.log(
    `OK: no OpenServ SDK reachability markers under .next/server (${result.filesScanned} files scanned)`,
  );
  process.exit(0);
} catch (err) {
  console.error("FAIL: .next/server OpenServ reachability check");
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
