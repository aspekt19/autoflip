/** Hide concatenated option codes such as Premium+AWP+M/R. Keep a normal trim name. */
export function buyerTrim(trim: string | null | undefined): string {
  const text = (trim?.trim() ?? "").replace(/\bPZEV\b/g, "partial zero-emission");
  if (!text || !text.includes("+")) return text;
  const words = text
    .split("+")
    .map((part) => part.trim())
    .filter((part) => /^[A-Za-z][a-z]{2,}$/.test(part));
  return words[0] ?? "";
}
