/** Hide concatenated option codes and emissions jargon. Keep a normal trim name. */
export function buyerTrim(trim: string | null | undefined): string {
  const text = (trim?.trim() ?? "")
    .replace(/\bpartial\s+zero[-\s]?emission\b/gi, "")
    .replace(/\bPZEV\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,/-])/g, "$1")
    .trim();
  if (!text || !text.includes("+")) return text;
  const words = text
    .split("+")
    .map((part) => part.trim())
    .filter((part) => /^[A-Za-z][a-z]{2,}$/.test(part));
  return words[0] ?? "";
}
