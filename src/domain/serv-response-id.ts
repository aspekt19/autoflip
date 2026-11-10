/**
 * Provider response ids vs locally generated call tracking ids.
 * Never display a client UUID (or chatcmpl-<uuid>) as an OpenSERV response id.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bare UUID — our Radar callId shape (crypto.randomUUID). */
export function isLocalCallUuid(id: string): boolean {
  return UUID_RE.test(id.trim());
}

/**
 * OpenSERV sometimes returns chatcmpl-<uuid> on error bodies; real completion
 * ids look like chatcmpl-Eia7… (no UUID dashes). Treat UUID-shaped ids as not
 * displayable provider response ids.
 */
export function isSyntheticChatCmplId(id: string): boolean {
  const trimmed = id.trim();
  if (/^chatcmpl-/i.test(trimmed)) {
    const rest = trimmed.slice("chatcmpl-".length);
    if (isLocalCallUuid(rest)) return true;
  }
  return false;
}

/** Unit-test mock ids — never a live OpenSERV completion. */
export function isSyntheticTestId(id: string): boolean {
  return /^synthetic-test-/i.test(id.trim());
}

/** True when this string must never be shown as a provider response id. */
export function isNonProviderResponseId(id: string): boolean {
  const trimmed = id.trim();
  if (!trimmed) return true;
  if (isLocalCallUuid(trimmed)) return true;
  if (isSyntheticChatCmplId(trimmed)) return true;
  if (isSyntheticTestId(trimmed)) return true;
  return false;
}

/**
 * Normalize a raw openserv.id for user-facing trails/journals.
 * Returns null when missing or locally/synthetically shaped.
 */
export function providerResponseId(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (isNonProviderResponseId(trimmed)) return null;
  return trimmed;
}

/**
 * Response id for display/storage from a SERV call.
 * Error bodies often still carry an `id` — never treat that as a provider response id.
 * Only successful completions may surface an id.
 */
export function providerResponseIdFromCall(input: {
  ok: boolean;
  id?: string | null;
}): string | null {
  if (!input.ok) return null;
  return providerResponseId(input.id);
}
