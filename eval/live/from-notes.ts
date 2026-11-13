import type { GeneratedQuery, LiveEvalProduct } from "./types";

export type EvalNoteInput = {
  product: LiveEvalProduct;
  note: string;
  zip?: string | null;
};

/**
 * Custom live-eval notes. Strings alternate Find/Resale (same split as generateQueries
 * for 2 or 4 slots). Objects may set product and ZIP explicitly. No shopper-chat parsing
 * of the note text — ZIP is only the structured field the caller passed.
 */
export function parseEvalNotes(raw: unknown): EvalNoteInput[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: EvalNoteInput[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (typeof item === "string" && item.trim()) {
      out.push({
        product: i % 2 === 0 ? "find" : "resale",
        note: item.trim(),
      });
      continue;
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const note = typeof row.note === "string" ? row.note.trim() : "";
    if (!note) continue;
    const product: LiveEvalProduct =
      row.product === "resale" || row.product === "find"
        ? row.product
        : i % 2 === 0
          ? "find"
          : "resale";
    const zipRaw = typeof row.zip === "string" ? row.zip.trim() : "";
    const zip = /^\d{5}$/.test(zipRaw) ? zipRaw : null;
    out.push({ product, note, zip });
  }
  return out.length > 0 ? out : undefined;
}

export function queriesFromEvalNotes(
  notes: readonly EvalNoteInput[],
  maxQueries: number,
): GeneratedQuery[] {
  const n = Math.max(1, Math.floor(maxQueries));
  return notes.slice(0, n).map((item, i) => ({
    id: `${String(i + 1).padStart(2, "0")}_${item.product}_custom`,
    product: item.product,
    note: item.note,
    zip: item.zip ?? null,
    distanceMiles: null,
    tags: {
      product: item.product,
      city: "custom",
      budget: "custom",
      body: "custom",
      need: "custom",
      messy: false,
    },
  }));
}
