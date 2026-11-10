/**
 * Merge-gate wrapper. Runs the Find → SERV → Watch → radar verdict_decide
 * acceptance suite and exits non-zero on any failure.
 *
 * Usage: npm run test:acceptance:find-radar-serv
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const result = spawnSync(
  process.execPath,
  [
    path.join(root, "node_modules/vitest/vitest.mjs"),
    "run",
    "src/server/find-radar-serv-acceptance.test.ts",
  ],
  { cwd: root, stdio: "inherit", env: process.env },
);

process.exit(result.status === null ? 1 : result.status);
