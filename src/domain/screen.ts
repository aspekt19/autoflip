const INJECTION = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /system\s+prompt/i,
  /reveal\s+your\s+(instructions|prompt|rules)/i,
  /you\s+are\s+now\b/i,
  /\bdo\s+not\s+follow\b/i,
  /<\s*\/?\s*(system|prompt|instructions)\s*>/i,
];

export function screenUserInput(text: string): { ok: true; text: string } | { ok: false; reason: string } {
  const cleaned = text.replace(/\u0000/g, "").trim();
  if (!cleaned) return { ok: false, reason: "Enter a VIN, a listing URL, or a make and model." };
  if (cleaned.length > 2000) return { ok: false, reason: "That input is too long. Paste a single listing URL, VIN, or search." };
  for (const pattern of INJECTION) {
    if (pattern.test(cleaned)) {
      return { ok: false, reason: "That input was rejected by the local input screen." };
    }
  }
  return { ok: true, text: cleaned };
}
