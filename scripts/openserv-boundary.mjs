/**
 * Fail-closed OpenServ / vulnerable-dev-dep boundary scanners (Node-only).
 * Used by CI and unit tests. Never treat a failed/incomplete scan as OK.
 */
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Specifiers that must not appear in production source imports. */
export const FORBIDDEN_PACKAGE_SPECIFIERS = Object.freeze([
  "@openserv-labs/sdk",
  "openai",
  "zod",
]);

/** Markers searched under .next/server (string reachability). */
export const NEXT_SERVER_FORBIDDEN_MARKERS = Object.freeze([
  "@openserv-labs/sdk",
  "openserv-labs/sdk",
  "node_modules/@openserv",
]);

/**
 * Explicit allowlist: unmounted experimental SDK scaffold only.
 * Relative to repo root, posix-style.
 */
export const ALLOWED_SOURCE_REL_PATHS = Object.freeze([
  "src/server/openserv/scout-agent.ts",
]);

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const NEXT_SKIP = /\.map$/;

function toPosix(p) {
  return p.split(sep).join("/");
}

/**
 * Detect static/dynamic import/require/export-from of a bare package specifier,
 * or path imports into the unmounted openserv scaffold.
 */
export function findForbiddenImportHits(sourceText) {
  const hits = [];
  const packages = FORBIDDEN_PACKAGE_SPECIFIERS.map((s) =>
    s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  ).join("|");

  const patterns = [
    {
      name: "static_from",
      re: new RegExp(
        String.raw`(?:import|export)\s+(?:type\s+)?(?:[^'"\n;]+?\s+from\s+)?['"](${packages})['"]`,
        "g",
      ),
    },
    {
      name: "side_effect_import",
      re: new RegExp(String.raw`(?:^|[^.\w])import\s*['"](${packages})['"]`, "gm"),
    },
    {
      name: "dynamic_import",
      re: new RegExp(String.raw`\bimport\s*\(\s*['"](${packages})['"]\s*\)`, "g"),
    },
    {
      name: "require",
      re: new RegExp(String.raw`\brequire\s*\(\s*['"](${packages})['"]\s*\)`, "g"),
    },
    {
      name: "alias_openserv",
      re: /(?:import|export)\s+(?:type\s+)?(?:[^'"\n;]+?\s+from\s+)?['"]@\/server\/openserv(?:\/[^'"]*)?['"]|\b(?:import|require)\s*\(\s*['"]@\/server\/openserv(?:\/[^'"]*)?['"]\s*\)/g,
    },
    {
      name: "relative_openserv",
      re: /(?:import|export)\s+(?:type\s+)?(?:[^'"\n;]+?\s+from\s+)?['"](?:\.\.\/)+openserv(?:\/[^'"]*)?['"]|\b(?:import|require)\s*\(\s*['"](?:\.\.\/)+openserv(?:\/[^'"]*)?['"]\s*\)/g,
    },
  ];

  for (const { name, re } of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(sourceText)) !== null) {
      hits.push({ kind: name, match: m[0].trim().slice(0, 160), index: m.index });
    }
  }
  return hits;
}

function assertDir(dir) {
  if (!existsSync(dir)) {
    const err = new Error(`scan root missing: ${dir}`);
    err.code = "SCAN_ROOT_MISSING";
    throw err;
  }
  let st;
  try {
    st = statSync(dir);
  } catch (cause) {
    const err = new Error(`failed to stat scan root: ${dir}`);
    err.code = "SCAN_STAT_FAILED";
    err.cause = cause;
    throw err;
  }
  if (!st.isDirectory()) {
    const err = new Error(`scan root is not a directory: ${dir}`);
    err.code = "SCAN_ROOT_NOT_DIR";
    throw err;
  }
}

function listDir(dir) {
  try {
    return readdirSync(dir);
  } catch (cause) {
    const err = new Error(`failed to list directory: ${dir}`);
    err.code = "SCAN_LIST_FAILED";
    err.cause = cause;
    throw err;
  }
}

function safeStat(full) {
  try {
    return statSync(full);
  } catch (cause) {
    const err = new Error(`failed to stat: ${full}`);
    err.code = "SCAN_STAT_FAILED";
    err.cause = cause;
    throw err;
  }
}

/** Recursively collect non-test source files under src/. */
export function walkSourceFiles(dir, out = []) {
  assertDir(dir);
  for (const name of listDir(dir)) {
    if (name === "node_modules" || name === ".git" || name === ".next") continue;
    const full = join(dir, name);
    const st = safeStat(full);
    if (st.isDirectory()) {
      walkSourceFiles(full, out);
      continue;
    }
    if (!SOURCE_EXT.test(name)) continue;
    if (TEST_FILE.test(name)) continue;
    out.push(full);
  }
  return out;
}

/** Recursively collect files under .next/server (skip .map). */
export function walkNextServerFiles(dir, out = []) {
  assertDir(dir);
  for (const name of listDir(dir)) {
    const full = join(dir, name);
    const st = safeStat(full);
    if (st.isDirectory()) {
      walkNextServerFiles(full, out);
      continue;
    }
    if (NEXT_SKIP.test(name)) continue;
    out.push(full);
  }
  return out;
}

export function collectProductionSourceFiles(repoRoot) {
  const srcRoot = join(repoRoot, "src");
  const allow = new Set(ALLOWED_SOURCE_REL_PATHS.map(toPosix));
  const all = walkSourceFiles(srcRoot);
  const scanned = [];
  const allowed = [];
  for (const abs of all) {
    const rel = toPosix(relative(repoRoot, abs));
    if (allow.has(rel)) {
      allowed.push(rel);
      continue;
    }
    scanned.push(abs);
  }
  if (scanned.length < 1) {
    const err = new Error("production source scan collected zero files — refusing false OK");
    err.code = "SCAN_EMPTY";
    throw err;
  }
  // Allowlist must exist on disk; otherwise someone deleted the scaffold silently.
  for (const rel of allow) {
    if (!existsSync(join(repoRoot, rel))) {
      const err = new Error(`allowed scaffold path missing: ${rel}`);
      err.code = "ALLOWLIST_MISSING";
      throw err;
    }
  }
  return { scanned, allowed };
}

export function scanProductionSources(repoRoot) {
  const { scanned, allowed } = collectProductionSourceFiles(repoRoot);
  const offenders = [];
  for (const abs of scanned) {
    let text;
    try {
      text = readFileSync(abs, "utf8");
    } catch (cause) {
      const err = new Error(`failed to read source: ${abs}`);
      err.code = "SCAN_READ_FAILED";
      err.cause = cause;
      throw err;
    }
    const hits = findForbiddenImportHits(text);
    if (hits.length) {
      offenders.push({
        file: toPosix(relative(repoRoot, abs)),
        hits: hits.map((h) => ({ kind: h.kind, match: h.match })),
      });
    }
  }
  return {
    ok: offenders.length === 0,
    filesScanned: scanned.length,
    allowed,
    offenders,
  };
}

export function scanNextServerForOpenServ(repoRoot, nextServerDir = join(repoRoot, ".next", "server")) {
  const files = walkNextServerFiles(nextServerDir);
  if (files.length < 1) {
    const err = new Error(`.next/server scan collected zero files under ${nextServerDir}`);
    err.code = "SCAN_EMPTY";
    throw err;
  }
  const offenders = [];
  for (const abs of files) {
    let text;
    try {
      text = readFileSync(abs, "utf8");
    } catch (cause) {
      const err = new Error(`failed to read build artifact: ${abs}`);
      err.code = "SCAN_READ_FAILED";
      err.cause = cause;
      throw err;
    }
    for (const marker of NEXT_SERVER_FORBIDDEN_MARKERS) {
      if (text.includes(marker)) {
        offenders.push({
          file: toPosix(relative(repoRoot, abs)),
          marker,
        });
        break;
      }
    }
  }
  return {
    ok: offenders.length === 0,
    filesScanned: files.length,
    offenders,
  };
}

export function assertScanOk(result, label) {
  if (!result || typeof result.filesScanned !== "number" || result.filesScanned < 1) {
    throw new Error(`${label}: incomplete scan (no filesScanned) — fail closed`);
  }
  if (result.ok !== true) {
    const detail = JSON.stringify(result.offenders ?? result, null, 2);
    throw new Error(`${label}: forbidden markers found:\n${detail}`);
  }
}
