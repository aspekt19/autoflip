/**
 * Build the same Run the API stores, from a golden pipeline result, and keep it in Kv.
 */
import { MemoryKv } from "@/io/kv";
import { finalMatchesLastProgress, toRunView, type RunRecord } from "@/domain/run";
import { renderRunPermalinkHtml } from "@/domain/run-view";
import { insertRun, readRun } from "@/io/run-store";
import { syncRun } from "@/server/run-sync";
import type { GoldenRun } from "./types";

export async function storeGoldenRun(golden: Omit<GoldenRun, "final" | "elapsedMs" | "storedRun">): Promise<RunRecord> {
  const spec = golden.specs.at(-1);
  const note = spec?.note ?? "";
  const mode = spec?.mode === "flip" ? "flip" : "personal";
  const kv = new MemoryKv();
  const id = await syncRun(kv, {
    ownerId: "golden-owner",
    kind: mode === "flip" ? "resale" : "find",
    note,
    mode,
    formEdits: spec?.hard.zip?.value
      ? { zip: { value: spec.hard.zip.value, origin: "user" as const }, radiusMi: { value: spec.hard.radiusMi?.value ?? null, origin: "user" as const } }
      : null,
    proofs: golden.proofRecords.flatMap((row) =>
      row.purpose
        ? [{
            purpose: row.purpose,
            status: row.status ?? null,
            responseId: row.servResponseId ?? null,
            detail: row.reason ?? null,
          }]
        : [],
    ),
    listings: golden.listings.map((car) => ({
      vin: car.vin,
      year: car.year,
      make: car.make,
      model: car.model,
      trim: null,
      priceUsd: car.priceUsd,
      miles: car.miles,
      dealer: car.dealer,
      vdp: car.vdp,
      city: null,
      state: car.state,
    })),
    picks: golden.pickVin ? [golden.pickVin] : [],
    queryCount: golden.providerQueriesUsed,
    verdict: golden.verdict,
    confidence: golden.confidence,
    creditsCharged: golden.charged ? 1 : 0,
    terminal: true,
    sources: golden.providerQueriesUsed > 0 ? ["cars_for_sale"] : [],
  });
  if (!id) throw new Error(`${golden.caseId} did not store a run.`);
  const loaded = await readRun(kv, id);
  if (!loaded) throw new Error(`${golden.caseId} run was not readable.`);
  if (!finalMatchesLastProgress(loaded)) throw new Error(`${golden.caseId} run final does not match its last progress snapshot.`);
  // Touch the insert path too so a second writer cannot replace the id silently.
  const again = await insertRun(kv, loaded);
  if (again) throw new Error(`${golden.caseId} run id was not reserved.`);
  return loaded;
}

export function permalinkHtml(run: RunRecord): string {
  return renderRunPermalinkHtml(toRunView(run, null));
}
