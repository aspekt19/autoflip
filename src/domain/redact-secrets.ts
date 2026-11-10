/**
 * Redact credential-shaped secrets only. SERV notes and deep-check reasons are
 * not secrets — keep their prose for the decision journal.
 */

export function redactSecretsOnly(text: string): string {
  if (!text) return text;
  return text
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/\baf_[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/api[_-]?key\s*[:=]\s*\S+/gi, "api_key=[redacted]");
}
