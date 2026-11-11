#!/usr/bin/env node
/**
 * Export sealed SERV decision audit trails for write-ups.
 * Reads local file KV (`.data/kv.json`) when present; never invents rows.
 *
 * Usage:
 *   node scripts/export-serv-decision-trails.mjs
 *   node scripts/export-serv-decision-trails.mjs --out artifacts/serv-decision-trails.json
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const outPath =
  outIdx >= 0 && args[outIdx + 1]
    ? path.resolve(root, args[outIdx + 1])
    : null;

const kvPath = path.join(root, ".data", "kv.json");
if (!existsSync(kvPath)) {
  const empty = {
    schema: "lemonless.serv_decision_export.v1",
    generatedAt: new Date().toISOString(),
    trails: [],
    note: "No local .data/kv.json — nothing to export. Sealed trails appear after real runs persist.",
  };
  const text = JSON.stringify(empty, null, 2);
  if (outPath) writeFileSync(outPath, text);
  else process.stdout.write(text + "\n");
  process.exit(0);
}

let store;
try {
  store = JSON.parse(readFileSync(kvPath, "utf8"));
} catch (err) {
  console.error("Failed to read", kvPath, err instanceof Error ? err.message : err);
  process.exit(1);
}

const trails = [];
for (const [key, value] of Object.entries(store ?? {})) {
  if (!key.startsWith("decision-audit:") || key === "decision-audit:stats:v1" || key === "decision-audit:index:v1") {
    continue;
  }
  try {
    const trail = typeof value === "string" ? JSON.parse(value) : value;
    if (trail?.schemaVersion === "lemonless.decision_audit_chain.v1") {
      trails.push({
        key,
        reportId: trail.reportId,
        reportHash: trail.reportHash,
        tipHash: trail.tipHash,
        sealedAt: trail.sealedAt,
        steps: (trail.links ?? []).map((link) => ({
          index: link.index,
          step: link.step?.step,
          by: link.step?.by,
          origin: link.step?.origin,
          originReason: link.step?.originReason,
          modelId: link.step?.modelId,
          runId: link.step?.runId,
          timestamp: link.step?.timestamp,
          status: link.step?.status,
          output: link.step?.output,
        })),
      });
    }
  } catch {
    /* skip corrupt rows */
  }
}

const payload = {
  schema: "lemonless.serv_decision_export.v1",
  generatedAt: new Date().toISOString(),
  trailCount: trails.length,
  trails,
};
const text = JSON.stringify(payload, null, 2);
if (outPath) writeFileSync(outPath, text);
else process.stdout.write(text + "\n");
