/**
 * Buyer-facing sentences. One paragraph is shown once, in plain words.
 */

const SENTENCE_SPLIT = /(?<=[.!?])\s+/;

export function normalizeBuyerSpace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Drop a later sentence that repeats an earlier one, including when it is glued on without a period. */
export function collapseRepeatedSentences(value: string): string {
  const text = normalizeBuyerSpace(value);
  if (!text) return "";
  const parts = text.split(SENTENCE_SPLIT).map((part) => part.trim()).filter(Boolean);
  const kept: string[] = [];
  for (const part of parts) {
    const key = part.toLowerCase();
    if (kept.some((item) => item.toLowerCase() === key)) continue;
    const earlier = kept.find((item) => item.length >= 40 && key.includes(item.toLowerCase()));
    if (earlier) {
      const rest = part.slice(earlier.length).trim();
      if (rest && !kept.some((item) => item.toLowerCase() === rest.toLowerCase())) kept.push(rest);
      continue;
    }
    const laterHoldsEarlier = kept.findIndex((item) => key.length >= 40 && item.toLowerCase().includes(key));
    if (laterHoldsEarlier >= 0) continue;
    kept.push(part);
  }
  return kept.join(" ");
}

/** Join paragraphs that say the same thing only once. */
export function joinBuyerParts(parts: Array<string | null | undefined>): string {
  const out: string[] = [];
  for (const part of parts) {
    const norm = collapseRepeatedSentences(part ?? "");
    if (!norm) continue;
    const key = norm.toLowerCase();
    let skip = false;
    for (let i = 0; i < out.length; i += 1) {
      const prev = out[i]!.toLowerCase();
      if (prev.includes(key)) {
        skip = true;
        break;
      }
      if (key.includes(prev) && prev.length > 24) {
        out[i] = norm;
        skip = true;
        break;
      }
    }
    if (!skip) out.push(norm);
  }
  return collapseRepeatedSentences(out.join(" "));
}

export type RepeatedHit = { sentence: string };

/** A sentence of useful length that shows up twice in rendered text. */
export function findRepeatedSentence(value: string): RepeatedHit | null {
  const text = normalizeBuyerSpace(value.replace(/<[^>]+>/g, " "));
  const parts = text.split(SENTENCE_SPLIT).map((part) => part.trim()).filter((part) => part.length >= 40);
  const counts = new Map<string, { n: number; sample: string }>();
  for (const part of parts) {
    const key = part.toLowerCase();
    const row = counts.get(key) ?? { n: 0, sample: part };
    row.n += 1;
    counts.set(key, row);
  }
  for (const row of counts.values()) {
    if (row.n > 1) return { sentence: row.sample };
  }
  for (let i = 0; i < parts.length; i += 1) {
    const key = parts[i]!.toLowerCase();
    const rest = parts.slice(i + 1).join(" ").toLowerCase();
    if (rest.includes(key)) return { sentence: parts[i]! };
  }
  return null;
}

/**
 * Repeats inside the verdict block, or inside one car, count.
 * The same offer line on two different cars does not.
 */
export function findRepeatedSentenceInHtml(html: string): RepeatedHit | null {
  const chunks = html.split(/<section\b/i);
  for (const chunk of chunks) {
    const hit = findRepeatedSentence(visibleHtmlText(chunk));
    if (hit) return hit;
  }
  return null;
}

/** Visible permalink text, without scripts, styles, or the technical-details drawer. */
export function visibleHtmlText(html: string): string {
  const withoutTech = html.replace(/<details\b[^>]*class="technical-details"[\s\S]*?<\/details>/gi, " ");
  const withoutCode = withoutTech
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  const text = withoutCode.replace(/<[^>]+>/g, " ");
  return normalizeBuyerSpace(
    text
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'"),
  );
}
