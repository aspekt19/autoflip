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
 * ids look like chatcmpl-EhAee… (recorded shape from eval/results/serv-proof-trace.json;
 * no UUID dashes). Treat UUID-shaped ids as not displayable provider response ids.
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
 * A failed completion can still carry a real provider id (empty answer,
 * finish_reason length). Keep that id. Synthetic and local ids are still dropped.
 */
export function providerResponseIdFromCall(input: {
  ok: boolean;
  id?: string | null;
}): string | null {
  void input.ok;
  return providerResponseId(input.id);
}

/**
 * Graph run ids come from the OpenServ `x-openserv-request-id` header and are
 * often bare UUIDs. Those are real provider ids, unlike Radar's local callId
 * (also a UUID) which must never be shown as an OpenServ response id.
 * Keep UUIDs here; still drop synthetic-test and chatcmpl-<uuid> shapes.
 */
export function providerGraphRunId(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (isSyntheticChatCmplId(trimmed)) return null;
  if (isSyntheticTestId(trimmed)) return null;
  return trimmed;
}

/** True when this model/step is a SERV graph run (run ids may be UUIDs). */
export function isGraphModelId(modelId: string | null | undefined): boolean {
  if (typeof modelId !== "string") return false;
  return /(?:^|\b)graph:/i.test(modelId.trim()) || /^graph$/i.test(modelId.trim());
}

/**
 * Display/storage helper: keep UUID graph run ids when the model is a graph,
 * otherwise use the regular provider-response-id filter.
 */
export function journalProviderRunId(
  raw: string | null | undefined,
  modelId?: string | null,
): string | null {
  return isGraphModelId(modelId) ? providerGraphRunId(raw) : providerResponseId(raw);
}
